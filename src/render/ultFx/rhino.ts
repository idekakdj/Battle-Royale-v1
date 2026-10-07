/**
 * Rhino — Seismic Stampede VFX (v1.3).
 *
 *  cast     a path RIBBON (2.4 m wide, marching chevrons) from the rhino to the lock / aim line, plus a LOCK bracket
 *           on the locked foe (gold for the player, red brackets for bots); while the head lowers the hooves paw up
 *           dirt, two snorts of steam leave the nostrils.
 *  stage 1  the charge: the ribbon FOLLOWS the rhino every frame — it ends on the locked foe while homing, else runs
 *           ahead along the heading to the arena wall (or as far as the charge can still reach); a DUST WAKE
 *           streams from the hooves (heavier with speed), periodic ground dust rings on the stride, a light camera
 *           rumble for anyone near.
 *  stage 2  GORE: crack decal + debris burst + flash + impact ring at the hit, a shake; the lock bracket goes and the
 *           ribbon now runs to the wall the victim will be crushed on.
 *  stage 3  CRUSH: a wall-crush shock — large shock rings, stone-dust cloud, flying chips, crack decal, flash, a big shake.
 *  stage 4  SKID: a long dust plume sliding to a halt.
 * Sim ground truth: src/sim/ultimates/rhino.ts; numbers from `RHINO_STAMPEDE`.
 */

import * as THREE from 'three';
import { getRenderArena } from '../arenaContext';
import { RHINO_STAMPEDE as K } from '../../config/ultimates/rhino';
import { tierProfile } from '../quality';
import type { ReticleHandle, RibbonHandle } from './primitives';
import type { UltFx, UltFxContext } from './types';

const DUST = [0.66, 0.54, 0.38] as const;

interface Slot {
  active: boolean;
  ribbon: RibbonHandle | null;
  reticle: ReticleHandle | null;
  t0: number;
  /** Render time the charge began (-1 before). */
  tCharge: number;
  stage: number;
  lockId: number;
  acc: number;
  pawT: number;
  ring: number;
  width: number;
}

const slots: Slot[] = [];
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

function slot(id: number): Slot {
  let s = slots[id];
  if (s === undefined) {
    s = { active: false, ribbon: null, reticle: null, t0: 0, tCharge: -1, stage: 0, lockId: -1, acc: 0, pawT: 0, ring: 0, width: 2.4 };
    slots[id] = s;
  }
  return s;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (u: number): number => u * u * (3 - 2 * u);

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** Distance along the ray (x,z)+t(dx,dz) (unit dir) to the arena wall (0.5 m inside the rim). */
function rayToWall(x: number, z: number, dx: number, dz: number): number {
  const R = getRenderArena().wallRadius - 0.5;
  const b = x * dx + z * dz;
  const c = x * x + z * z - R * R;
  if (c > 0) return 0;
  return Math.max(0, -b + Math.sqrt(b * b - c));
}

function dust(ctx: UltFxContext, x: number, y: number, z: number, vx: number, vz: number, up: number, size: number, alpha = 0.5): void {
  const c = 0.85 + Math.random() * 0.3;
  ctx.effects.puff(x, y, z, vx + rand(-0.6, 0.6), up * rand(0.6, 1.3), vz + rand(-0.6, 0.6), rand(0.5, 1.0), size * 0.6, size * 1.8, DUST[0] * c, DUST[1] * c, DUST[2] * c, alpha, -1.2, 1.8);
}

function steam(ctx: UltFxContext, x: number, y: number, z: number, vx: number, vz: number): void {
  ctx.effects.puff(x, y, z, vx, rand(0.3, 0.8), vz, rand(0.5, 0.8), 0.12, 0.55, 0.93, 0.95, 0.97, 0.45, 0.2, 1.4);
}

function endSlot(id: number, s: Slot): void {
  if (s.ribbon !== null && s.ribbon.held(id)) s.ribbon.hide(0.25);
  if (s.reticle !== null && s.reticle.held(id)) s.reticle.hide(0.2);
  s.ribbon = null;
  s.reticle = null;
  s.active = false;
  s.tCharge = -1;
}

const rhinoFx: UltFx = {
  onTarget(ctx, ev) {
    if (ev.kind !== 'line') return;
    const id = ev.fighterId;
    const s = slot(id);
    endSlot(id, s);
    s.active = true;
    s.t0 = ctx.time;
    s.tCharge = -1;
    s.stage = 0;
    s.lockId = ev.targetId;
    s.acc = 0;
    s.pawT = 0;
    s.ring = 0;
    s.width = Math.max(1.2, ev.width);
    const style = ctx.styleFor(id);
    s.ribbon = ctx.indicators.ribbon(id);
    s.ribbon.show(ev.from.x, ev.from.y, ev.from.z, ev.to.x, ev.to.y, ev.to.z, s.width, style);
    s.ribbon.setReveal(0);
    s.ribbon.setHead(1);
    s.ribbon.setFlow(8, 0.9);
    if (ev.targetId >= 0) {
      // The lock bracket: gold for the player, red tracking brackets for a bot's lock.
      s.reticle = ctx.indicators.reticle(id);
      s.reticle.show(ev.to.x, ev.to.y, ev.to.z, 1.7, ctx.isPlayer(id) ? 'lock' : 'tracking');
    }
    // Two hard snorts: steam jets from the nostrils.
    ctx.fighterPos(id, _p);
    const yaw = ctx.fighterYaw(id);
    const n = Math.max(3, Math.round(8 * tierProfile().fxScale));
    for (let i = 0; i < n; i++) steam(ctx, _p.x + Math.sin(yaw) * 1.7 + rand(-0.2, 0.2), _p.y + 0.9, _p.z + Math.cos(yaw) * 1.7 + rand(-0.2, 0.2), Math.sin(yaw) * rand(0.8, 1.8), Math.cos(yaw) * rand(0.8, 1.8));
  },

  onStage(ctx, ev) {
    const id = ev.fighterId;
    const s = slots[id];
    if (s === undefined || !s.active) return;
    const fx = ctx.effects;
    s.stage = ev.stage;
    const q = tierProfile().fxScale;
    if (ev.stage === 1) {
      s.tCharge = ctx.time;
      ctx.fighterPos(id, _p);
      fx.groundDust(_p.x, _p.z, 2.4, 16);
      const n = Math.max(4, Math.round(14 * q));
      const yaw = ctx.fighterYaw(id);
      for (let i = 0; i < n; i++) dust(ctx, _p.x - Math.sin(yaw) * 1.2, _p.y + 0.2, _p.z - Math.cos(yaw) * 1.2, -Math.sin(yaw) * 3, -Math.cos(yaw) * 3, 2.2, 0.5);
      fx.addShake(0.05 * ctx.nearness(_p, 18));
      return;
    }
    if (ev.stage === 2) {
      // GORE.
      const pos = { x: ev.pos.x, y: ev.pos.y, z: ev.pos.z };
      const near = ctx.nearness(pos, 24);
      fx.crack(pos.x, pos.z, 1.8);
      fx.impactRing(pos, 1.0, 0xffe6bc, 0.4, 2.6, 0.26, 0.7);
      fx.flash(pos, 1.0, 0xffd9a0, 0.6, 3.2, 0.16, 0.8, 1.5);
      fx.burst(pos, 0xe6d2a4, 18, 6.5, 0.5, 0.13);
      fx.groundDust(pos.x, pos.z, 2.4, 14);
      fx.addShake(0.11 * near);
      if (s.reticle !== null && s.reticle.held(id)) s.reticle.hide(0.12);
      return;
    }
    if (ev.stage === 3) {
      // CRUSH against geometry.
      const pos = { x: ev.pos.x, y: ev.pos.y, z: ev.pos.z };
      const near = ctx.nearness(pos, 28);
      fx.crack(pos.x, pos.z, 3.6);
      fx.shockRing(pos, 0xe6c58a, 0.6, 6.4, 0.55, 1.5, 0.9);
      fx.shockRing(pos, 0x8a7a66, 0.3, 4.0, 0.4, 1.3, 0.8);
      fx.impactRing(pos, 1.0, 0xfff0d0, 0.6, 4.6, 0.32, 0.75);
      fx.flash(pos, 1.1, 0xffc880, 0.8, 5.5, 0.2, 0.85, 1.7);
      fx.burst(pos, 0xe9d7b0, 30, 9, 0.6, 0.15);
      fx.groundDust(pos.x, pos.z, 4.6, 30);
      const n = Math.max(8, Math.round(30 * q));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = rand(1.5, 5.5);
        const g = rand(0.35, 0.6);
        // Flying stone chips and grit.
        fx.puff(pos.x, pos.y + 1.0, pos.z, Math.cos(a) * sp, rand(2.5, 6.5), Math.sin(a) * sp, rand(0.6, 1.1), 0.12, 0.09, g, g * 0.92, g * 0.78, 0.9, -15, 0.6);
        if (i % 2 === 0) dust(ctx, pos.x + rand(-2, 2), pos.y + 0.3, pos.z + rand(-2, 2), Math.cos(a) * 1.4, Math.sin(a) * 1.4, 3.4, 0.7, 0.5);
      }
      fx.addShake(0.24 * near);
      if (s.ribbon !== null && s.ribbon.held(id)) s.ribbon.hide(0.15);
      if (s.reticle !== null && s.reticle.held(id)) s.reticle.hide(0.1);
      return;
    }
    if (ev.stage === 4) {
      // SKID / glancing stop: a long plume sliding to a halt.
      ctx.fighterPos(id, _p);
      fx.groundDust(_p.x, _p.z, 3.0, 22);
      const n = Math.max(5, Math.round(16 * q));
      for (let i = 0; i < n; i++) dust(ctx, _p.x + rand(-1.2, 1.2), _p.y + 0.2, _p.z + rand(-1.2, 1.2), rand(-2.5, 2.5), rand(-2.5, 2.5), 1.8, 0.7, 0.55);
      fx.addShake(0.06 * ctx.nearness(_p, 18));
      if (s.ribbon !== null && s.ribbon.held(id)) s.ribbon.hide(0.2);
      if (s.reticle !== null && s.reticle.held(id)) s.reticle.hide(0.15);
    }
  },

  onFrame(ctx, snapshot, dt) {
    const fx = ctx.effects;
    const q = tierProfile().fxScale;
    for (let id = 0; id < slots.length; id++) {
      const s = slots[id];
      if (s === undefined || !s.active) continue;
      const st = snapshot.fighters[id];
      if (st === undefined) continue;
      ctx.fighterPos(id, _p);
      const yaw = ctx.fighterYaw(id);
      const dx = Math.sin(yaw);
      const dz = Math.cos(yaw);
      const t = ctx.time - s.t0;
      const windup = st.ultPhase === 'windup';

      // ── Ribbon: where the charge is going ──
      let tx: number;
      let tz: number;
      const victim = st.ultTargetId ?? -1;
      const homing = st.ultPhase === 'active' && s.stage === 1 && victim >= 0;
      if ((windup && s.lockId >= 0) || homing) {
        ctx.fighterPos(windup ? s.lockId : victim, _q);
        tx = _q.x;
        tz = _q.z;
      } else {
        const remaining = s.tCharge >= 0 ? K.speed * Math.max(0.3, K.chargeS - (ctx.time - s.tCharge)) : K.speed * K.chargeS;
        const reach = Math.min(remaining, rayToWall(_p.x, _p.z, dx, dz), windup ? K.lockRange : 40);
        tx = _p.x + dx * reach;
        tz = _p.z + dz * reach;
      }
      if (s.ribbon !== null && s.ribbon.held(id)) {
        s.ribbon.update(_p.x, _p.y, _p.z, tx, _p.y, tz, s.width);
        if (windup) s.ribbon.setReveal(smooth(clamp01(t / (K.pawS * 0.7))));
        else s.ribbon.setReveal(1);
        if (!windup) s.ribbon.setFlow(14, 0.8);
      }
      if (s.reticle !== null && s.reticle.held(id) && s.lockId >= 0) {
        ctx.fighterPos(s.lockId, _q);
        s.reticle.update(_q.x, _q.y, _q.z, 1.7);
        if (!windup && s.reticle.style !== 'committed' && !ctx.isPlayer(id)) s.reticle.setStyle('committed');
        s.reticle.setCommit(windup ? clamp01(t / K.pawS) : 1);
      }

      // ── Windup: paw dust ──
      if (windup) {
        s.pawT += dt;
        if (s.pawT >= 0.19) {
          s.pawT -= 0.19;
          const side = Math.random() < 0.5 ? -0.45 : 0.45;
          const fx0 = _p.x + dx * 1.35 + dz * side;
          const fz0 = _p.z + dz * 1.35 - dx * side;
          const n = Math.max(2, Math.round(5 * q));
          for (let i = 0; i < n; i++) dust(ctx, fx0, _p.y + 0.12, fz0, -dx * rand(1, 3) + dz * side * 2, -dz * rand(1, 3) - dx * side * 2, 1.8, 0.3);
          fx.spark(fx0, _p.y + 0.2, fz0, -dx * 2, 2.2, -dz * 2, 0.35, 0.07, 0.02, 0.85, 0.72, 0.5, 0.7, -10, 1);
        }
        continue;
      }

      // ── Charge: the dust wake ──
      const speed = Math.hypot(st.vel.x, st.vel.z);
      if (speed > 3) {
        const sk = speed / K.speed;
        s.acc += dt * 70 * sk * q;
        while (s.acc >= 1) {
          s.acc -= 1;
          const lat = rand(-0.8, 0.8);
          dust(ctx, _p.x - dx * rand(0.6, 1.6) + dz * lat, _p.y + 0.15, _p.z - dz * rand(0.6, 1.6) - dx * lat, -dx * speed * 0.25, -dz * speed * 0.25, 1.4 + sk, 0.45 + 0.25 * sk);
        }
        s.ring += dt * speed * 0.27; // stride cadence
        if (s.ring >= 1) {
          s.ring -= 1;
          fx.groundDust(_p.x - dx * 0.8, _p.z - dz * 0.8, 1.2 + 0.6 * sk, 6);
          fx.addShake(0.012 * ctx.nearness(_p, 14));
        }
      }
    }
  },

  onEnd(_ctx, fighterId) {
    const s = slots[fighterId];
    if (s !== undefined) endSlot(fighterId, s);
  },

  dispose() {
    slots.length = 0;
  },
};

export default rhinoFx;
