/**
 * Gorilla — Boulder Hurl VFX (v1.3).
 *
 *  cast       (time-keyed off the caster's `actionT`) a thump of dust and a pale shock ring at the feet with every chest
 *             BEAT; the RIP at 0.6 s: a crack decal, a dust ring and stone chips at the slab's source in front of
 *             the gorilla; pebbles trickle off the slab while it is hoisted overhead
 *  heave      a dashed ballistic ARC from the hands to the predicted landing point (it follows the locked foe: the
 *             sim's lagging centre, smoothed) and a tracking reticle under it (gold for the player, red for others)
 *  stage 1    RELEASE: the arc and a solid committed landing ring + dashed splash ring (2.5 m) re-parent to a
 *             long-lived owner so they survive the gorilla's recovery; the ring's warning fill runs with the flight;
 *             dust at the feet, a flash and streaks at the hands
 *  impact     (`projectileImpact`, after the generic boulder crack/dust in Effects) the markers go; a hit on a body
 *             adds a stone-chip burst and a red ring
 * The flying boulder itself is drawn by ProjectileRenderer; the held slab lives on the rig (Gorilla.ts).
 */

import * as THREE from 'three';
import { GORILLA_HURL as K } from '../../config/ultimates/gorilla';
import type { ArcHandle, ReticleHandle, RingHandle } from './primitives';
import { tierProfile } from '../quality';
import type { UltFx } from './types';

type Phase = 'idle' | 'heave' | 'flight';

/** Flight markers are owned by `FLIGHT_OWNER + id` so the dispatcher's `releaseOwner(id)` (end of the recovery) leaves them alone. */
const FLIGHT_OWNER = 1000;

interface Slot {
  phase: Phase;
  mine: boolean;
  lastT: number;
  beats: number;
  ripped: boolean;
  /** Heave markers (owner = fighter id). */
  arc: ArcHandle | null;
  reticle: ReticleHandle | null;
  /** Flight markers (owner = FLIGHT_OWNER + id). */
  fArc: ArcHandle | null;
  fReticle: ReticleHandle | null;
  fRing: RingHandle | null;
  /** Latest predicted landing (from stage events) and its smoothed drawn position. */
  tx: number;
  tz: number;
  gy: number;
  cx: number;
  cz: number;
  /** Flight: start time and expected duration. */
  t0: number;
  dur: number;
  /** Release point (world). */
  rx: number;
  ry: number;
  rz: number;
  slab: THREE.Object3D | null;
  trickle: number;
}

const slots: Slot[] = [];
const _p = new THREE.Vector3();
const _w = new THREE.Vector3();

function slot(id: number): Slot {
  let s = slots[id];
  if (s === undefined) {
    s = {
      phase: 'idle', mine: false, lastT: 0, beats: 0, ripped: false,
      arc: null, reticle: null, fArc: null, fReticle: null, fRing: null,
      tx: 0, tz: 0, gy: 0, cx: 0, cz: 0, t0: 0, dur: 1, rx: 0, ry: 0, rz: 0, slab: null, trickle: 0,
    };
    slots[id] = s;
  }
  return s;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number): number => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
const easeOutCubic = (u: number): number => 1 - Math.pow(1 - u, 3);

/** Flight time of a throw of horizontal length `d` (mirrors the sim). */
function flightTime(d: number): number {
  return Math.max(K.minFlightS, d / K.speed);
}

/** Dashed-arc apex above the chord of a constant-gravity lob with flight time `T`. */
function arcHeight(T: number): number {
  return (K.gravity * T * T) / 8;
}

function hideHeave(id: number, s: Slot, fade = 0.12): void {
  if (s.arc !== null && s.arc.held(id)) s.arc.hide(fade);
  if (s.reticle !== null && s.reticle.held(id)) s.reticle.hide(fade);
  s.arc = null;
  s.reticle = null;
}

function hideFlight(id: number, s: Slot, fade = 0.14): void {
  const o = FLIGHT_OWNER + id;
  if (s.fArc !== null && s.fArc.held(o)) s.fArc.hide(fade);
  if (s.fReticle !== null && s.fReticle.held(o)) s.fReticle.hide(fade);
  if (s.fRing !== null && s.fRing.held(o)) s.fRing.hide(fade);
  s.fArc = null;
  s.fReticle = null;
  s.fRing = null;
}

function reset(id: number, s: Slot): void {
  hideHeave(id, s, 0);
  hideFlight(id, s, 0);
  s.phase = 'idle';
  s.lastT = 0;
  s.beats = 0;
  s.ripped = false;
  s.slab = null;
  s.trickle = 0;
}

/** World position of the release point for a gorilla drawn at `_p` facing `yaw`. */
function releasePoint(s: Slot, px: number, py: number, pz: number, yaw: number): void {
  s.rx = px + Math.sin(yaw) * K.releaseForward;
  s.ry = py + K.releaseHeight;
  s.rz = pz + Math.cos(yaw) * K.releaseForward;
}

const gorillaFx: UltFx = {
  onTarget(ctx, ev) {
    if (ev.kind !== 'line') return;
    const id = ev.fighterId;
    const s = slot(id);
    reset(id, s);
    s.phase = 'heave';
    s.mine = ctx.isPlayer(id);
    s.tx = s.cx = ev.to.x;
    s.tz = s.cz = ev.to.z;
    s.gy = ev.to.y;
    const style = s.mine ? 'friendly' : 'tracking';
    ctx.fighterPos(id, _p);
    releasePoint(s, _p.x, _p.y, _p.z, ctx.fighterYaw(id));
    const d = Math.hypot(s.cx - s.rx, s.cz - s.rz);
    s.arc = ctx.indicators.arc(id);
    s.arc.show(s.rx, s.ry, s.rz, s.cx, s.gy + K.aimHeight, s.cz, arcHeight(flightTime(d)), 0.3, style);
    s.arc.setReveal(0);
    s.arc.setDash(0.7, 1.8);
    s.reticle = ctx.indicators.reticle(id);
    s.reticle.show(s.cx, s.gy, s.cz, 2.6, s.mine ? 'lock' : 'tracking');
  },

  onStage(ctx, ev) {
    const id = ev.fighterId;
    const s = slots[id];
    if (s === undefined) return;
    const fx = ctx.effects;
    if (ev.stage === 0) {
      if (s.phase !== 'heave') return;
      s.tx = ev.pos.x;
      s.tz = ev.pos.z;
      s.gy = ev.pos.y;
      return;
    }
    if (ev.stage === 1) {
      // RELEASE: freeze the landing point; the markers move to a long-lived owner.
      if (s.phase !== 'heave') return;
      s.tx = s.cx = ev.pos.x;
      s.tz = s.cz = ev.pos.z;
      s.gy = ev.pos.y;
      ctx.fighterPos(id, _p);
      const yaw = ctx.fighterYaw(id);
      releasePoint(s, _p.x, _p.y, _p.z, yaw);
      const d = Math.hypot(s.cx - s.rx, s.cz - s.rz);
      s.dur = flightTime(d);
      s.t0 = ctx.time;
      hideHeave(id, s, 0.06);
      const o = FLIGHT_OWNER + id;
      s.fArc = ctx.indicators.arc(o);
      s.fArc.show(s.rx, s.ry, s.rz, s.cx, s.gy + K.aimHeight, s.cz, arcHeight(s.dur), 0.32, 'committed');
      s.fArc.setDash(0.6, 2.6);
      s.fReticle = ctx.indicators.reticle(o);
      s.fReticle.show(s.cx, s.gy, s.cz, 1.9, 'committed');
      s.fReticle.setCommit(0);
      s.fRing = ctx.indicators.ring(o);
      s.fRing.show(s.cx, s.gy, s.cz, K.impactRadius, 0.09, 'committed');
      s.fRing.setDash(30, 0.5);
      s.fRing.setAlpha(0.55);
      s.phase = 'flight';

      // The throw: dust kicked up at the feet, a flash and streaks where the boulder leaves the hands.
      const near = ctx.nearness(_p, 16);
      fx.groundDust(_p.x, _p.z, 1.5, 7);
      fx.shockRing({ x: _p.x, y: _p.y, z: _p.z }, 0xd9c7a0, 0.4, 2.4, 0.4, 1.1, 0.6);
      const rel = { x: s.rx, y: s.ry, z: s.rz };
      fx.flash(rel, s.ry, 0xfff0d0, 0.5, 1.8, 0.14, 0.7, 1.4);
      fx.burst(rel, 0xffe2b0, 8, 5, 0.3, 0.1);
      fx.addShake(0.04 * near);
    }
    // Stage 2 (the landing): the `projectileImpact` hook draws it and clears the markers.
  },

  onImpact(ctx, ev) {
    const id = ev.ownerId;
    const s = slots[id];
    if (s === undefined) return;
    hideFlight(id, s, 0.12);
    s.phase = 'idle';
    const fx = ctx.effects;
    const pos = { x: ev.pos.x, y: Math.max(0.3, ev.pos.y), z: ev.pos.z };
    // Shards and a wide dust bloom on top of the generic crack/dust the match already draws.
    const n = Math.max(4, Math.round(14 * tierProfile().fxScale));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2.5 + Math.random() * 5;
      const c = 0.42 + Math.random() * 0.2;
      fx.puff(pos.x, pos.y + 0.3, pos.z, Math.cos(a) * sp, 3 + Math.random() * 4, Math.sin(a) * sp, 0.9 + Math.random() * 0.6, 0.12, 0.3, c + 0.08, c, c - 0.08, 0.85, -14, 0.6);
    }
    fx.shockRing(pos, 0xe8d8b0, 0.6, ev.radius * 1.15, 0.45, 1.2, 0.7);
    if (ev.hitId >= 0) {
      // A body took it: a hard red-gold ring on top.
      fx.impactRing(pos, 0.6, 0xff8a4c, 0.4, ev.radius * 0.9, 0.3, 0.7);
      fx.burst(pos, 0xffc98a, 12, 7, 0.45, 0.14);
    }
  },

  onFrame(ctx, snapshot, dt) {
    for (let id = 0; id < slots.length; id++) {
      const s = slots[id];
      if (s === undefined || s.phase === 'idle') continue;
      const st = snapshot.fighters[id];
      const fx = ctx.effects;

      if (s.phase === 'heave') {
        if (st === undefined || !st.alive || st.action !== 'ultimate') {
          // Interrupted / dead before the release: no boulder will come.
          reset(id, s);
          continue;
        }
        const t = st.actionT;
        ctx.fighterPos(id, _p);
        const yaw = ctx.fighterYaw(id);
        const near = ctx.nearness(_p, 18);

        // Time-keyed beats (robust against the pose being a pure function of actionT).
        for (let i = 0; i < K.beatAt.length; i++) {
          const bit = 1 << i;
          if ((s.beats & bit) === 0 && s.lastT < K.beatAt[i] && t >= K.beatAt[i]) {
            s.beats |= bit;
            fx.groundDust(_p.x, _p.z, 1.1, 4);
            fx.shockRing({ x: _p.x, y: _p.y, z: _p.z }, 0xe8dcc0, 0.3, 1.9 + 0.3 * i, 0.32, 1.0, 0.5);
            fx.flash({ x: _p.x + Math.sin(yaw) * 0.3, y: _p.y, z: _p.z + Math.cos(yaw) * 0.3 }, _p.y + 1.55, 0xfff0d0, 0.3, 1.1, 0.12, 0.5, 1.2);
            fx.addShake((0.03 + 0.02 * i) * near);
          }
        }
        if (!s.ripped && s.lastT < K.ripAt && t >= K.ripAt) {
          s.ripped = true;
          // The slab's source: in front of the gorilla, between its fists.
          const sx = _p.x + Math.sin(yaw) * 0.95;
          const sz = _p.z + Math.cos(yaw) * 0.95;
          fx.crack(sx, sz, 1.5);
          fx.groundDust(sx, sz, 1.8, 12);
          fx.shockRing({ x: sx, y: _p.y, z: sz }, 0xd9c7a0, 0.4, 2.6, 0.45, 1.1, 0.7);
          const n = Math.max(4, Math.round(12 * tierProfile().fxScale));
          for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const sp = 1.6 + Math.random() * 3.2;
            const c = 0.4 + Math.random() * 0.2;
            fx.puff(sx, _p.y + 0.2, sz, Math.cos(a) * sp, 2.4 + Math.random() * 3.6, Math.sin(a) * sp, 0.8 + Math.random() * 0.5, 0.1, 0.26, c + 0.1, c, c - 0.08, 0.85, -14, 0.5);
          }
          fx.addShake(0.06 * near);
        }
        s.lastT = t;

        // Pebbles trickle off the slab while it is hoisted.
        if (t > K.ripAt + 0.05 && t < K.windupS) {
          if (s.slab === null) s.slab = ctx.fighterObject(id).getObjectByName('boulder-slab') ?? null;
          if (s.slab !== null && s.slab.visible) {
            s.trickle += dt * 26 * tierProfile().fxScale;
            while (s.trickle >= 1) {
              s.trickle -= 1;
              s.slab.getWorldPosition(_w);
              fx.puff(_w.x + (Math.random() - 0.5) * 0.7, _w.y - 0.3, _w.z + (Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.8, -0.4 - Math.random() * 0.8, (Math.random() - 0.5) * 0.8, 0.5 + Math.random() * 0.3, 0.05, 0.1, 0.5, 0.44, 0.36, 0.8, -6, 1);
            }
          }
        }

        // Predicted landing: the arc + reticle follow the sim's (lagging) centre, smoothed.
        const k = 1 - Math.exp(-dt / 0.06);
        s.cx += (s.tx - s.cx) * k;
        s.cz += (s.tz - s.cz) * k;
        releasePoint(s, _p.x, _p.y, _p.z, yaw);
        const d = Math.hypot(s.cx - s.rx, s.cz - s.rz);
        if (s.arc !== null && s.arc.held(id)) {
          s.arc.update(s.rx, s.ry, s.rz, s.cx, s.gy + K.aimHeight, s.cz, arcHeight(flightTime(d)), 0.3);
          s.arc.setReveal(smooth((t - 0.42) / 0.34));
        }
        if (s.reticle !== null && s.reticle.held(id)) {
          const u = clamp01(t / K.windupS);
          s.reticle.update(s.cx, s.gy, s.cz, 2.6 - 0.7 * easeOutCubic(u));
        }
      } else if (s.phase === 'flight') {
        const u = clamp01((ctx.time - s.t0) / s.dur);
        const o = FLIGHT_OWNER + id;
        if (s.fReticle !== null && s.fReticle.held(o)) {
          s.fReticle.update(s.cx, s.gy, s.cz, 1.9);
          s.fReticle.setCommit(u);
        }
        if (s.fRing !== null && s.fRing.held(o)) s.fRing.update(s.cx, s.gy, s.cz, K.impactRadius, 0.09);
        // Safety net: the boulder expired / never reported (left the bowl): clean up.
        if (ctx.time - s.t0 > s.dur + 1.2) {
          hideFlight(id, s, 0.2);
          s.phase = 'idle';
        }
      }
    }
  },

  onEnd(_ctx, fighterId) {
    // The caster's recovery ended (or it died / was stunned). Heave markers go; flight markers belong to the
    // boulder, which keeps flying, and are cleared by its impact.
    const s = slots[fighterId];
    if (s === undefined) return;
    hideHeave(fighterId, s, 0.12);
    if (s.phase === 'heave') s.phase = 'idle';
    s.lastT = 0;
    s.beats = 0;
    s.ripped = false;
    s.slab = null;
  },

  dispose() {
    slots.length = 0;
  },
};

export default gorillaFx;
