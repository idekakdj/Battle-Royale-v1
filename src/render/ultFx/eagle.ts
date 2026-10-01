/**
 * Eagle — Death From Above VFX (v1.3).
 *
 *  cast     takeoff dust ring + feather burst at the launch point; a lock-on reticle (gold brackets for the
 *           player, red for others) snaps onto the victim and follows them exactly while the eagle spirals up
 *           (a trail of wind glints marks the helix).
 *  stage 0  the reticle switches to the tracking style: it follows the sim's LAGGING centre (events every
 *           0.1 s, smoothed) — you can see it trail a runner.
 *  stage 1  COMMIT: the circle freezes as a solid red ring with a warning fill growing over the 0.5 s, a dashed
 *           splash ring (3 m) and a translucent light shaft up to the sky. Leave the circle to dodge.
 *  stoop    (caster snapshot: ultStage 1 and falling fast) a streak of glints + wind puffs along the dive line.
 *  stage 2  IMPACT: ground crack, dust ring, shock rings, flash, sparks and feathers; screen shake by proximity.
 */

import * as THREE from 'three';
import { EAGLE_DFA } from '../../config/ultimates/eagle';
import type { ReticleHandle, RingHandle } from './primitives';
import { tierProfile } from '../quality';
import type { UltFx, UltFxContext } from './types';

type Phase = 'idle' | 'seek' | 'track' | 'commit' | 'done';

interface Slot {
  phase: Phase;
  victim: number;
  reticle: ReticleHandle | null;
  splash: RingHandle | null;
  shaft: THREE.Mesh | null;
  t0: number;
  tCommit: number;
  /** Smoothed reticle centre / event target / committed point. */
  cx: number;
  cz: number;
  tx: number;
  tz: number;
  gy: number;
  mine: boolean;
  diveStarted: boolean;
  trailAcc: number;
}

const slots: Slot[] = [];
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();

// Shared shaft resources (one geometry / material per match; the material's alpha is animated per frame).
let shaftGeo: THREE.BufferGeometry | null = null;
const SHAFT_H = 26;

function makeShaft(ctx: UltFxContext): THREE.Mesh {
  if (shaftGeo === null) {
    shaftGeo = new THREE.CylinderGeometry(1, 1, SHAFT_H, 18, 1, true);
    shaftGeo.translate(0, SHAFT_H / 2, 0);
  }
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uAlpha: { value: 0 }, uColor: { value: new THREE.Color(0xff5a3c) } },
    vertexShader: `varying float vH; void main(){ vH = position.y / ${SHAFT_H.toFixed(1)}; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uAlpha; uniform vec3 uColor; varying float vH; void main(){ float a = uAlpha * pow(clamp(1.0 - vH, 0.0, 1.0), 1.7); gl_FragColor = vec4(uColor, a); }`,
  });
  const m = new THREE.Mesh(shaftGeo, mat);
  m.frustumCulled = false;
  m.visible = false;
  ctx.scene.add(m);
  return m;
}

function slot(id: number): Slot {
  let s = slots[id];
  if (s === undefined) {
    s = {
      phase: 'idle', victim: -1, reticle: null, splash: null, shaft: null, t0: 0, tCommit: 0,
      cx: 0, cz: 0, tx: 0, tz: 0, gy: 0, mine: false, diveStarted: false, trailAcc: 0,
    };
    slots[id] = s;
  }
  return s;
}

function shaftAlpha(s: Slot, a: number, x: number, z: number, r: number): void {
  if (s.shaft === null) return;
  const mat = s.shaft.material as THREE.ShaderMaterial;
  mat.uniforms.uAlpha.value = a;
  s.shaft.visible = a > 0.005;
  s.shaft.position.set(x, s.gy, z);
  s.shaft.scale.set(r, 1, r);
}

function release(id: number, s: Slot): void {
  if (s.reticle !== null && s.reticle.held(id)) s.reticle.hide(0.14);
  if (s.splash !== null && s.splash.held(id)) s.splash.hide(0.14);
  if (s.shaft !== null) s.shaft.visible = false;
  s.reticle = null;
  s.splash = null;
  s.phase = 'idle';
  s.victim = -1;
  s.diveStarted = false;
}

const easeOutCubic = (u: number): number => 1 - Math.pow(1 - u, 3);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const eagleFx: UltFx = {
  onTarget(ctx, ev) {
    if (ev.kind !== 'lock') return;
    const id = ev.fighterId;
    const s = slot(id);
    release(id, s);
    s.phase = 'seek';
    s.victim = ev.targetId;
    s.t0 = ctx.time;
    s.mine = ctx.isPlayer(id);
    s.cx = s.tx = ev.to.x;
    s.cz = s.tz = ev.to.z;
    s.gy = ev.to.y;
    s.reticle = ctx.indicators.reticle(id);
    s.reticle.show(ev.to.x, ev.to.y, ev.to.z, 3.4, s.mine ? 'lock' : 'tracking');
    s.trailAcc = 0;

    // Takeoff: dust kicked up and a burst of feathers around the launch point.
    const fx = ctx.effects;
    const from = ev.from;
    fx.groundDust(from.x, from.z, 2.2, 14);
    fx.shockRing({ x: from.x, y: from.y, z: from.z }, 0xe8d8b0, 0.4, 2.4, 0.4, 1.1, 0.7);
    const n = Math.max(3, Math.round(10 * tierProfile().fxScale));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.4 + Math.random() * 2.2;
      fx.puff(from.x, from.y + 0.6, from.z, Math.cos(a) * sp, 1.8 + Math.random() * 2.4, Math.sin(a) * sp, 0.9 + Math.random() * 0.5, 0.16, 0.34, 0.86, 0.78, 0.6, 0.85, -2.2, 1.6);
    }
    fx.addShake(0.05 * ctx.nearness(from, 16));
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
      if (s.phase === 'seek') {
        s.phase = 'track';
        s.t0 = ctx.time;
        // Lock-in: the wide seeking bracket settles onto the sim's lagging reticle.
        if (s.reticle !== null && s.reticle.held(id)) s.reticle.setStyle('tracking');
      }
      return;
    }
    if (ev.stage === 1) {
      // COMMIT: freeze the circle, solid red ring, warning fill, splash ring and the light shaft.
      s.phase = 'commit';
      s.tCommit = ctx.time;
      s.cx = s.tx = ev.pos.x;
      s.cz = s.tz = ev.pos.z;
      s.gy = ev.pos.y;
      if (s.reticle === null || !s.reticle.held(id)) s.reticle = ctx.indicators.reticle(id);
      const r = s.reticle;
      if (!r.shown) r.show(s.cx, s.gy, s.cz, EAGLE_DFA.directRadius, 'committed');
      r.setStyle('committed');
      r.update(s.cx, s.gy, s.cz, EAGLE_DFA.directRadius);
      r.setCommit(0);
      s.splash = ctx.indicators.ring(id);
      s.splash.show(s.cx, s.gy, s.cz, 3, 0.09, 'committed');
      s.splash.setDash(30, 0.5);
      s.splash.setAlpha(0.55);
      if (s.shaft === null) s.shaft = makeShaft(ctx);
      const pos = { x: s.cx, y: s.gy, z: s.cz };
      fx.shockRing(pos, 0xff5a3c, 3.2, 1.4, 0.3, 1.1, 0.7); // contracting "lock" ring
      fx.flash(pos, 0.4, 0xff7a55, 0.6, 2.2, 0.22, 0.6, 1.2);
      fx.addShake(0.02 * ctx.nearness(pos, 14));
      return;
    }
    // stage 2: impact.
    const pos = { x: ev.pos.x, y: ev.pos.y, z: ev.pos.z };
    const near = ctx.nearness(pos, 22);
    fx.crack(pos.x, pos.z, 2.3);
    fx.groundDust(pos.x, pos.z, 3.6, 24);
    fx.shockRing(pos, 0xffe2b0, 0.5, 4.2, 0.5, 1.5, 0.9);
    fx.shockRing(pos, 0xff8a4c, 0.3, 2.4, 0.3, 1.4, 0.8);
    fx.impactRing(pos, 0.5, 0xfff0d0, 0.4, 3.4, 0.3, 0.7);
    fx.flash(pos, 0.6, 0xffc98a, 1.2, 4.2, 0.2, 0.9, 1.7);
    fx.burst(pos, 0xffd39a, 22, 8, 0.55, 0.16);
    // Feathers and dust cloud thrown up by the impact.
    const n = Math.max(4, Math.round(16 * tierProfile().fxScale));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 4.5;
      const c = i % 3 === 0 ? 0.95 : 0.55;
      fx.puff(pos.x, pos.y + 0.5, pos.z, Math.cos(a) * sp, 2.5 + Math.random() * 4, Math.sin(a) * sp, 1.0 + Math.random() * 0.9, 0.14, 0.32, c, c * 0.85, c * 0.62, 0.9, -3.4, 1.4);
    }
    fx.addShake(0.11 * near);
    if (s.reticle !== null && s.reticle.held(id)) s.reticle.hide(0.12);
    if (s.splash !== null && s.splash.held(id)) s.splash.hide(0.12);
    if (s.shaft !== null) s.shaft.visible = false;
    s.phase = 'done';
  },

  onFrame(ctx, snapshot, dt) {
    for (let id = 0; id < slots.length; id++) {
      const s = slots[id];
      if (s === undefined || s.phase === 'idle') continue;
      const st = snapshot.fighters[id];
      if (st === undefined) continue;
      const fx = ctx.effects;

      if (s.phase === 'seek' || s.phase === 'track') {
        // Where the reticle is drawn: exactly on the victim while seeking, then the sim's lagging centre.
        if (s.phase === 'seek' && s.victim >= 0) {
          ctx.fighterPos(s.victim, _v);
          s.cx = _v.x;
          s.cz = _v.z;
        } else {
          const k = 1 - Math.exp(-dt / 0.06);
          s.cx += (s.tx - s.cx) * k;
          s.cz += (s.tz - s.cz) * k;
        }
        if (s.reticle !== null && s.reticle.held(id)) {
          const u = clamp01((ctx.time - s.t0) / (s.phase === 'seek' ? EAGLE_DFA.ascentS : EAGLE_DFA.trackS));
          // Lock-in animation: wide bracket tightens onto the victim during the ascent, then the tracking bracket stays close.
          const r = s.phase === 'seek' ? 3.4 - 1.5 * easeOutCubic(u) : 1.9 - 0.25 * easeOutCubic(u);
          s.reticle.update(s.cx, s.gy, s.cz, r);
        }
        // Wind glints spiralling up the helix while the eagle climbs out of sight.
        if (st.action === 'ultimate' && st.ultPhase === 'windup') {
          ctx.fighterPos(id, _p);
          s.trailAcc += dt * 60 * tierProfile().fxScale;
          while (s.trailAcc >= 1) {
            s.trailAcc -= 1;
            fx.spark(_p.x + (Math.random() - 0.5) * 0.4, _p.y - 0.1, _p.z + (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 1.2, -1.5, (Math.random() - 0.5) * 1.2, 0.5, 0.12, 0.02, 0.9, 0.95, 1, 0.8, -1, 2.5);
            if (Math.random() < 0.5) fx.puff(_p.x, _p.y - 0.2, _p.z, (Math.random() - 0.5) * 1.5, -1, (Math.random() - 0.5) * 1.5, 0.8, 0.14, 0.3, 0.9, 0.85, 0.72, 0.5, -0.5, 2);
          }
        }
      } else if (s.phase === 'commit') {
        const u = clamp01((ctx.time - s.tCommit) / EAGLE_DFA.commitS);
        if (s.reticle !== null && s.reticle.held(id)) {
          s.reticle.update(s.cx, s.gy, s.cz, EAGLE_DFA.directRadius);
          s.reticle.setCommit(u);
        }
        if (s.splash !== null && s.splash.held(id)) s.splash.update(s.cx, s.gy, s.cz, 3, 0.09);
        // Shaft brightens through the warning and stays on for the whole stoop.
        shaftAlpha(s, 0.16 + 0.4 * easeOutCubic(u), s.cx, s.cz, 0.5 + 0.5 * (1 - u));

        // Stoop streak: caster falling fast (rig position is interpolated, as drawn).
        if (st.vel.y < -6) {
          if (!s.diveStarted) {
            s.diveStarted = true;
            fx.addShake(0.03 * ctx.nearness(st.pos, 16));
          }
          ctx.fighterPos(id, _p);
          const sp = Math.hypot(st.vel.x, st.vel.y, st.vel.z);
          const dx = st.vel.x / sp;
          const dy = st.vel.y / sp;
          const dz = st.vel.z / sp;
          s.trailAcc += dt * 90 * tierProfile().fxScale;
          while (s.trailAcc >= 1) {
            s.trailAcc -= 1;
            const j = Math.random();
            // Streak sparks trail back along the line, wind puffs billow to the sides.
            fx.spark(_p.x - dx * j * 1.2 + (Math.random() - 0.5) * 0.5, _p.y - dy * j * 1.2 + 0.2, _p.z - dz * j * 1.2 + (Math.random() - 0.5) * 0.5, -dx * 3, -dy * 3, -dz * 3, 0.32, 0.2, 0.02, 0.85, 0.92, 1, 0.9, 0, 3);
            if (Math.random() < 0.35) fx.puff(_p.x - dx * 1.5, _p.y - dy * 1.5, _p.z - dz * 1.5, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 0.6, 0.2, 0.7, 0.92, 0.92, 0.95, 0.35, 0, 2.2);
          }
        }
      } else if (s.phase === 'done') {
        // Impact already fired; the dispatcher's onEnd clears the slot when the ultimate finishes.
      }
    }
  },

  onEnd(ctx, fighterId) {
    const s = slots[fighterId];
    if (s === undefined) return;
    if (s.reticle !== null && s.reticle.held(fighterId)) s.reticle.hide(0.12);
    if (s.splash !== null && s.splash.held(fighterId)) s.splash.hide(0.12);
    if (s.shaft !== null) s.shaft.visible = false;
    s.reticle = null;
    s.splash = null;
    s.phase = 'idle';
    s.victim = -1;
    s.diveStarted = false;
    void ctx;
  },

  dispose() {
    for (const s of slots) {
      if (s === undefined || s.shaft === null) continue;
      s.shaft.parent?.remove(s.shaft);
      (s.shaft.material as THREE.Material).dispose();
    }
    if (shaftGeo !== null) shaftGeo.dispose();
    shaftGeo = null;
    slots.length = 0;
  },
};

export default eagleFx;
