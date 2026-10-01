/**
 * Crocodile — DEATH ROLL VFX (v1.3). Sand, not water: dust wakes, sand sprays and ground shocks.
 *
 *  cast      lock reticle on the victim (gold 'lock' for the player, red 'tracking' for others) + a lunge-line
 *            ribbon croc -> victim that TRACKS the victim while the croc coils and hisses (puffs at the jaws).
 *  COMMIT    the ribbon freezes at the sim's lunge end point and turns solid red, the reticle goes 'committed':
 *            step out of the line now.
 *  LUNGE     explosive takeoff burst, then a dust wake behind the croc every frame while it flies.
 *  CLAMP     impact at the victim: flash, ivory sparks, sand puffs, ring, shake.
 *  DRAG      dust wake while it backs away hauling the victim.
 *  ROLL 1-3  continuous sand kicks + one dust ring / radial sand spray / shock ring PER REVOLUTION (stage beats).
 *  TOSS      heavy ground impact at the victim: shock ring, dust ring, crack, sparks, flash, stronger shake.
 *  WHIFF     slide plume while the croc skids out.
 * Everything is keyed by the caster id, so a second crocodile would just work.
 */

import * as THREE from 'three';
import { CROC_STAGE, CROC } from '../../config/ultimates/crocodile';
import type { ReticleHandle, RibbonHandle } from './primitives';
import { ARENA } from '../../config/balance';
import { tierProfile } from '../quality';
import type { UltFx, UltFxContext } from './types';

type Mode = 'idle' | 'track' | 'commit' | 'lunge' | 'clamp' | 'drag' | 'roll' | 'slide' | 'done';

interface Slot {
  mode: Mode;
  victim: number;
  reticle: ReticleHandle | null;
  ribbon: RibbonHandle | null;
  t0: number;
  windup: number;
  modeT0: number;
  /** Frozen lunge end point. */
  ex: number;
  ez: number;
  mine: boolean;
  acc: number;
  revs: number;
}

const slots: Slot[] = [];
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = { x: 0, y: 0, z: 0 };

const SAND = { r: 0.8, g: 0.66, b: 0.44 };
const DUST = { r: 0.66, g: 0.56, b: 0.4 };
const IVORY = 0xf4ecd0;
const SAND_HEX = 0xd9b77a;
const RIBBON_W = 1.7;

function slot(id: number): Slot {
  let s = slots[id];
  if (s === undefined) {
    s = { mode: 'idle', victim: -1, reticle: null, ribbon: null, t0: 0, windup: 0.55, modeT0: 0, ex: 0, ez: 0, mine: false, acc: 0, revs: 0 };
    slots[id] = s;
  }
  return s;
}

/** Ground height under (x, z): the dais top inside r = 4, else the sand (mirrors MovementSystem.groundHeightAt). */
function gy(x: number, z: number): number {
  return x * x + z * z <= 16 ? ARENA.daisY : ARENA.groundY;
}

/**
 * Height for a flat ribbon A -> B: the primitives draw it at one constant height, so ride the dais top whenever the
 * path touches the dais (r = 4), else the sand.
 */
function segY(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, -(ax * dx + az * dz) / l2)) : 0;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  return cx * cx + cz * cz <= 16.5 ? ARENA.daisY : ARENA.groundY;
}

function fx(): number {
  return tierProfile().fxScale;
}

function setP(x: number, y: number, z: number): typeof _p {
  _p.x = x;
  _p.y = y;
  _p.z = z;
  return _p;
}

function clearMarkers(s: Slot, id: number): void {
  if (s.reticle !== null && s.reticle.held(id)) s.reticle.hide(0.12);
  if (s.ribbon !== null && s.ribbon.held(id)) s.ribbon.hide(0.3);
  s.reticle = null;
  s.ribbon = null;
}

/** A few sand puffs thrown in a cone (used for wakes / sprays). */
function sandPuffs(ctx: UltFxContext, x: number, z: number, n: number, dirX: number, dirZ: number, speed: number, spread: number, size: number): void {
  const c = Math.max(1, Math.round(n * fx()));
  for (let i = 0; i < c; i++) {
    const a = Math.atan2(dirX, dirZ) + (Math.random() - 0.5) * spread;
    const sp = speed * (0.4 + Math.random() * 0.8);
    ctx.effects.puff(
      x + (Math.random() - 0.5) * 0.5, gy(x, z) + 0.12 + Math.random() * 0.25, z + (Math.random() - 0.5) * 0.5,
      Math.sin(a) * sp, 0.6 + Math.random() * 1.6, Math.cos(a) * sp,
      0.55 + Math.random() * 0.5, size * 0.5, size * (1.3 + Math.random() * 0.8),
      SAND.r, SAND.g, SAND.b, 0.42, -2.2, 2.4,
    );
  }
}

/** Radial spray ring of sand (one per death-roll revolution). */
function radialSpray(ctx: UltFxContext, x: number, z: number, n: number, speed: number): void {
  const c = Math.max(4, Math.round(n * fx()));
  for (let i = 0; i < c; i++) {
    const a = (i / c) * Math.PI * 2 + Math.random() * 0.3;
    const sp = speed * (0.55 + Math.random() * 0.6);
    ctx.effects.puff(
      x, gy(x, z) + 0.25, z,
      Math.cos(a) * sp, 1.6 + Math.random() * 1.6, Math.sin(a) * sp,
      0.6 + Math.random() * 0.4, 0.3, 1.0 + Math.random() * 0.6,
      DUST.r, DUST.g, DUST.b, 0.5, -5, 1.6,
    );
  }
}

const crocodileFx: UltFx = {
  onTarget(ctx, ev) {
    if (ev.kind !== 'lock') return;
    const s = slot(ev.fighterId);
    clearMarkers(s, ev.fighterId);
    s.mode = 'track';
    s.victim = ev.targetId;
    s.t0 = ctx.time;
    s.windup = Math.max(0.1, ev.windup);
    s.mine = ctx.isPlayer(ev.fighterId);
    s.revs = 0;
    s.acc = 0;
    s.reticle = ctx.indicators.reticle(ev.fighterId);
    s.reticle.show(ev.to.x, gy(ev.to.x, ev.to.z), ev.to.z, 1.6, s.mine ? 'lock' : 'tracking');
    s.ribbon = ctx.indicators.ribbon(ev.fighterId);
    const ry = segY(ev.from.x, ev.from.z, ev.to.x, ev.to.z);
    s.ribbon.show(ev.from.x, ry, ev.from.z, ev.to.x, ry, ev.to.z, RIBBON_W, ctx.styleFor(ev.fighterId));
    s.ribbon.setFlow(5, 1.0);
  },

  onFrame(ctx, snapshot, dt) {
    for (let id = 0; id < slots.length; id++) {
      const s = slots[id];
      if (s === undefined || s.mode === 'idle' || s.mode === 'done') continue;
      const st = snapshot.fighters[id];
      if (st === undefined) continue;
      ctx.fighterPos(id, _a);
      const vOk = s.victim >= 0 && snapshot.fighters[s.victim] !== undefined;
      if (vOk) ctx.fighterPos(s.victim, _b);

      if (s.mode === 'track' || s.mode === 'commit') {
        const p = Math.min(1, (ctx.time - s.t0) / s.windup);
        if (s.reticle !== null && s.reticle.held(id) && vOk) {
          s.reticle.update(_b.x, gy(_b.x, _b.z), _b.z, 1.6);
          if (s.mode === 'commit') s.reticle.setCommit(Math.min(1, (ctx.time - s.modeT0) / Math.max(0.05, s.windup * (1 - CROC.commitFrac))));
        }
        if (s.ribbon !== null && s.ribbon.held(id)) {
          if (s.mode === 'track' && vOk) {
            const ry = segY(_a.x, _a.z, _b.x, _b.z);
            s.ribbon.update(_a.x, ry, _a.z, _b.x, ry, _b.z, RIBBON_W);
          } else {
            const ry = segY(_a.x, _a.z, s.ex, s.ez);
            s.ribbon.update(_a.x, ry, _a.z, s.ex, ry, s.ez, RIBBON_W);
          }
        }
        // Coil + hiss: a little sand kicked up at the jaws.
        if (p > 0.1) {
          s.acc += dt;
          if (s.acc > 0.11) {
            s.acc = 0;
            const yaw = ctx.fighterYaw(id);
            sandPuffs(ctx, _a.x + Math.sin(yaw) * 1.5, _a.z + Math.cos(yaw) * 1.5, 1, Math.sin(yaw), Math.cos(yaw), 0.7, 1.4, 0.4);
          }
        }
      } else if (s.mode === 'lunge') {
        const yaw = ctx.fighterYaw(id);
        sandPuffs(ctx, _a.x - Math.sin(yaw) * 0.8, _a.z - Math.cos(yaw) * 0.8, 3, -Math.sin(yaw), -Math.cos(yaw), 3.2, 1.3, 0.55);
      } else if (s.mode === 'drag') {
        s.acc += dt;
        if (s.acc > 0.035) {
          s.acc = 0;
          const yaw = ctx.fighterYaw(id);
          sandPuffs(ctx, _a.x + Math.sin(yaw) * 0.5, _a.z + Math.cos(yaw) * 0.5, 2, Math.sin(yaw), Math.cos(yaw), 2.4, 1.6, 0.5);
        }
      } else if (s.mode === 'roll') {
        s.acc += dt;
        if (s.acc > 0.05) {
          s.acc = 0;
          const ang = Math.random() * Math.PI * 2;
          sandPuffs(ctx, _a.x, _a.z, 2, Math.cos(ang), Math.sin(ang), 3.0, 1.4, 0.45);
          if (vOk) {
            ctx.effects.spark(_b.x, _b.y + 0.4, _b.z, Math.cos(ang) * 2, 2 + Math.random() * 2, Math.sin(ang) * 2, 0.35, 0.12, 0.03, 1, 0.92, 0.7, 0.9, -9, 2);
          }
        }
      } else if (s.mode === 'slide') {
        const yaw = ctx.fighterYaw(id);
        if ((Math.round(ctx.time * 60) & 1) === 0) sandPuffs(ctx, _a.x, _a.z, 1, -Math.sin(yaw), -Math.cos(yaw), 2.2, 2.0, 0.42);
        if (ctx.time - s.modeT0 > CROC.slideT + 0.1) s.mode = 'done';
      }
    }
  },

  onStage(ctx, ev) {
    const id = ev.fighterId;
    const s = slot(id);
    const near = ctx.nearness(ev.pos, 16);
    switch (ev.stage) {
      case CROC_STAGE.COMMIT: {
        s.mode = 'commit';
        s.modeT0 = ctx.time;
        s.ex = ev.pos.x;
        s.ez = ev.pos.z;
        if (s.ribbon !== null && s.ribbon.held(id)) {
          s.ribbon.setStyle('committed');
          s.ribbon.setFlow(11, 0.8);
        }
        if (s.reticle !== null && s.reticle.held(id)) {
          s.reticle.setStyle('committed');
          s.reticle.setCommit(0);
        }
        break;
      }
      case CROC_STAGE.LUNGE: {
        s.mode = 'lunge';
        s.modeT0 = ctx.time;
        ctx.fighterPos(id, _a);
        ctx.effects.groundDust(_a.x, _a.z, 2.2, 12);
        ctx.effects.shockRing(setP(_a.x, gy(_a.x, _a.z), _a.z), SAND_HEX, 0.5, 2.6, 0.3, 1.1, 0.6);
        ctx.effects.addShake(0.05 * near);
        if (s.ribbon !== null && s.ribbon.held(id)) s.ribbon.hide(0.35);
        if (s.reticle !== null && s.reticle.held(id)) s.reticle.hide(0.12);
        s.ribbon = null;
        s.reticle = null;
        break;
      }
      case CROC_STAGE.CLAMP: {
        s.mode = 'clamp';
        s.modeT0 = ctx.time;
        ctx.effects.flash(ev.pos, 0.8, 0xfff0c0, 0.6, 2.4, 0.22, 0.85, 1.6);
        ctx.effects.burst(ev.pos, IVORY, 18, 6.5, 0.45, 0.13);
        sandPuffs(ctx, ev.pos.x, ev.pos.z, 8, 0, 1, 3, Math.PI * 2, 0.7);
        ctx.effects.impactRing(ev.pos, 0.8, 0xffe9b0, 0.2, 1.9, 0.3, 0.7);
        ctx.effects.addShake(0.13 * near);
        break;
      }
      case CROC_STAGE.DRAG: {
        s.mode = 'drag';
        s.modeT0 = ctx.time;
        s.acc = 0;
        break;
      }
      case CROC_STAGE.ROLL1:
      case CROC_STAGE.ROLL2:
      case CROC_STAGE.ROLL3: {
        const rev = ev.stage - CROC_STAGE.ROLL1; // 0..2
        s.mode = 'roll';
        s.modeT0 = ctx.time;
        ctx.fighterPos(id, _a);
        const r = 2.3 + 0.35 * rev;
        ctx.effects.groundDust(_a.x, _a.z, r, 14 + rev * 3);
        ctx.effects.shockRing(setP(_a.x, gy(_a.x, _a.z), _a.z), SAND_HEX, 0.7, r + 0.6, 0.38, 1.2, 0.55 + 0.1 * rev);
        radialSpray(ctx, ev.pos.x, ev.pos.z, 10 + rev * 3, 3.2 + rev * 0.7);
        ctx.effects.burst(ev.pos, IVORY, 8 + rev * 2, 4.5, 0.4, 0.1);
        ctx.effects.addShake((0.07 + 0.03 * rev) * near);
        break;
      }
      case CROC_STAGE.TOSS: {
        s.mode = 'done';
        clearMarkers(s, id);
        ctx.effects.shockRing(setP(ev.pos.x, gy(ev.pos.x, ev.pos.z), ev.pos.z), SAND_HEX, 0.6, 3.8, 0.5, 1.4, 0.85);
        ctx.effects.groundDust(ev.pos.x, ev.pos.z, 3.3, 24);
        ctx.effects.crack(ev.pos.x, ev.pos.z, 1.6);
        ctx.effects.flash(ev.pos, 0.6, 0xffe2a0, 0.8, 3.2, 0.26, 0.85, 1.5);
        ctx.effects.burst(ev.pos, IVORY, 22, 8, 0.5, 0.14);
        radialSpray(ctx, ev.pos.x, ev.pos.z, 14, 5);
        ctx.effects.addShake(0.22 * near);
        break;
      }
      case CROC_STAGE.WHIFF: {
        s.mode = 'slide';
        s.modeT0 = ctx.time;
        clearMarkers(s, id);
        ctx.effects.groundDust(ev.pos.x, ev.pos.z, 2.4, 16);
        break;
      }
      default:
        break;
    }
  },

  onEnd(_ctx, fighterId) {
    const s = slots[fighterId];
    if (s !== undefined) {
      s.mode = 'idle';
      s.victim = -1;
      s.reticle = null;
      s.ribbon = null;
    }
  },

  dispose() {
    slots.length = 0;
  },
};

export default crocodileFx;
