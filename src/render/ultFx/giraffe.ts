/**
 * Giraffe — Timber Fall VFX (v1.3).
 *
 *  cast     dust at the hooves as the neck rears; a lock-on reticle (gold brackets for the player, red for others) snaps
 *           onto the victim
 *  stage 0  the reticle switches to the tracking style: it follows the sim's LAGGING centre (events every 0.1 s,
 *           smoothed) — you can see it trail a runner
 *  stage 1  COMMIT: the circle freezes as a solid red ring with a warning fill growing through the 0.5 s (and the
 *           slam swing), a dashed shock ring (2.2 m), and a faint path ribbon from the giraffe to the circle showing
 *           where the felled neck will land. Leave the circle to dodge.
 *  stage 2  SLAM: a big radial crack, a fast shock ring to the 2.2 m edge and a slower dust ring, a flash, a column
 *           of dirt and stone chips and a hard screen shake by proximity
 */

import * as THREE from 'three';
import { GIRAFFE_TIMBER as K } from '../../config/ultimates/giraffe';
import type { ReticleHandle, RibbonHandle, RingHandle } from './primitives';
import { tierProfile } from '../quality';
import type { UltFx } from './types';

type Phase = 'idle' | 'track' | 'commit' | 'done';

interface Slot {
  phase: Phase;
  victim: number;
  mine: boolean;
  reticle: ReticleHandle | null;
  shock: RingHandle | null;
  path: RibbonHandle | null;
  t0: number;
  tCommit: number;
  /** Smoothed reticle centre / event target / ground height. */
  cx: number;
  cz: number;
  tx: number;
  tz: number;
  gy: number;
}

const slots: Slot[] = [];
const _p = new THREE.Vector3();

function slot(id: number): Slot {
  let s = slots[id];
  if (s === undefined) {
    s = { phase: 'idle', victim: -1, mine: false, reticle: null, shock: null, path: null, t0: 0, tCommit: 0, cx: 0, cz: 0, tx: 0, tz: 0, gy: 0 };
    slots[id] = s;
  }
  return s;
}

function release(id: number, s: Slot, fade = 0.14): void {
  if (s.reticle !== null && s.reticle.held(id)) s.reticle.hide(fade);
  if (s.shock !== null && s.shock.held(id)) s.shock.hide(fade);
  if (s.path !== null && s.path.held(id)) s.path.hide(fade);
  s.reticle = null;
  s.shock = null;
  s.path = null;
  s.phase = 'idle';
  s.victim = -1;
}

const easeOutCubic = (u: number): number => 1 - Math.pow(1 - u, 3);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const giraffeFx: UltFx = {
  onTarget(ctx, ev) {
    if (ev.kind !== 'lock') return;
    const id = ev.fighterId;
    const s = slot(id);
    release(id, s, 0);
    s.phase = 'track';
    s.victim = ev.targetId;
    s.t0 = ctx.time;
    s.mine = ctx.isPlayer(id);
    s.cx = s.tx = ev.to.x;
    s.cz = s.tz = ev.to.z;
    s.gy = ev.to.y;
    s.reticle = ctx.indicators.reticle(id);
    s.reticle.show(ev.to.x, ev.to.y, ev.to.z, 3.0, s.mine ? 'lock' : 'tracking');
    // The neck rears: a puff of dust at the planted hooves.
    const fx = ctx.effects;
    fx.groundDust(ev.from.x, ev.from.z, 1.6, 8);
    fx.addShake(0.02 * ctx.nearness(ev.from, 14));
  },

  onStage(ctx, ev) {
    const id = ev.fighterId;
    const s = slots[id];
    if (s === undefined || s.phase === 'idle') return;
    const fx = ctx.effects;
    if (ev.stage === 0) {
      s.tx = ev.pos.x;
      s.tz = ev.pos.z;
      s.gy = ev.pos.y;
      return;
    }
    if (ev.stage === 1) {
      // COMMIT: freeze the circle; solid ring, warning fill, shock ring and the slam path.
      s.phase = 'commit';
      s.tCommit = ctx.time;
      s.cx = s.tx = ev.pos.x;
      s.cz = s.tz = ev.pos.z;
      s.gy = ev.pos.y;
      if (s.reticle === null || !s.reticle.held(id)) s.reticle = ctx.indicators.reticle(id);
      const r = s.reticle;
      if (!r.shown) r.show(s.cx, s.gy, s.cz, K.directRadius, 'committed');
      r.setStyle('committed');
      r.update(s.cx, s.gy, s.cz, K.directRadius);
      r.setCommit(0);
      s.shock = ctx.indicators.ring(id);
      s.shock.show(s.cx, s.gy, s.cz, K.shockRadius + 0.3, 0.09, 'committed');
      s.shock.setDash(32, 0.45);
      s.shock.setAlpha(0.55);
      ctx.fighterPos(id, _p);
      s.path = ctx.indicators.ribbon(id);
      s.path.show(_p.x, s.gy, _p.z, s.cx, s.gy, s.cz, 0.9, 'committed');
      s.path.setAlpha(0.4);
      const pos = { x: s.cx, y: s.gy, z: s.cz };
      fx.shockRing(pos, 0xff5a3c, 3.0, 1.4, 0.3, 1.1, 0.7); // contracting "lock" ring
      fx.addShake(0.02 * ctx.nearness(pos, 14));
      return;
    }
    // stage 2: SLAM.
    const pos = { x: ev.pos.x, y: ev.pos.y, z: ev.pos.z };
    const near = ctx.nearness(pos, 22);
    fx.crack(pos.x, pos.z, 2.9);
    fx.groundDust(pos.x, pos.z, 4.0, 26);
    fx.shockRing(pos, 0xfff0d0, 0.5, K.shockRadius + 0.6, 0.3, 1.5, 0.9);
    fx.shockRing(pos, 0xd9c7a0, 0.4, 4.2, 0.6, 1.1, 0.7);
    fx.impactRing(pos, 0.5, 0xffe2b0, 0.4, K.shockRadius, 0.26, 0.75);
    fx.flash(pos, 0.6, 0xffc98a, 1.0, 4.4, 0.18, 0.85, 1.6);
    fx.burst(pos, 0xffd39a, 18, 8, 0.5, 0.15);
    // A column of dirt and stone chips thrown up by the felled neck.
    const n = Math.max(5, Math.round(18 * tierProfile().fxScale));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.6 + Math.random() * 4.6;
      const c = i % 3 === 0 ? 0.55 : 0.4;
      fx.puff(pos.x, pos.y + 0.3, pos.z, Math.cos(a) * sp, 2.8 + Math.random() * 5, Math.sin(a) * sp, 0.9 + Math.random() * 0.8, 0.12, 0.3, c + 0.1, c, c - 0.1, 0.9, -13, 0.6);
    }
    fx.addShake(0.13 * near);
    if (s.reticle !== null && s.reticle.held(id)) s.reticle.hide(0.12);
    if (s.shock !== null && s.shock.held(id)) s.shock.hide(0.12);
    if (s.path !== null && s.path.held(id)) s.path.hide(0.1);
    s.phase = 'done';
  },

  onFrame(ctx, snapshot, dt) {
    for (let id = 0; id < slots.length; id++) {
      const s = slots[id];
      if (s === undefined || s.phase === 'idle') continue;
      const st = snapshot.fighters[id];
      if (st === undefined) continue;

      if (s.phase === 'track') {
        // Where the reticle is drawn: on the victim for the first instant, then the sim's lagging centre.
        const k = 1 - Math.exp(-dt / 0.06);
        s.cx += (s.tx - s.cx) * k;
        s.cz += (s.tz - s.cz) * k;
        if (s.reticle !== null && s.reticle.held(id)) {
          const u = clamp01((ctx.time - s.t0) / K.trackS);
          // The wide bracket tightens onto the victim while the neck rears.
          s.reticle.update(s.cx, s.gy, s.cz, 2.6 - 0.75 * easeOutCubic(u));
          if (u > 0.05 && s.reticle.style === 'lock' && !s.mine) s.reticle.setStyle('tracking');
        }
      } else if (s.phase === 'commit') {
        const u = clamp01((ctx.time - s.tCommit) / (K.commitS + K.slamS));
        if (s.reticle !== null && s.reticle.held(id)) {
          s.reticle.update(s.cx, s.gy, s.cz, K.directRadius);
          s.reticle.setCommit(u);
        }
        if (s.shock !== null && s.shock.held(id)) s.shock.update(s.cx, s.gy, s.cz, K.shockRadius + 0.3, 0.09);
        if (s.path !== null && s.path.held(id)) {
          ctx.fighterPos(id, _p);
          s.path.update(_p.x, s.gy, _p.z, s.cx, s.gy, s.cz, 0.9);
        }
      }
    }
  },

  onEnd(_ctx, fighterId) {
    const s = slots[fighterId];
    if (s === undefined) return;
    release(fighterId, s, 0.12);
  },

  dispose() {
    slots.length = 0;
  },
};

export default giraffeFx;
