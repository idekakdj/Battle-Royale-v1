/**
 * Mole — Sinkhole Vortex VFX (v1.3).
 *
 *  cast     dirt spray + dust ring as the mole digs in; a TREMOR CRACK ribbon races from the mole to the zone
 *           (`setReveal`, chevrons marching) while the mole tunnels underneath it (dirt kicked up along the
 *           path, crack decals left behind); the zone circle shows its warning fill growing to the collapse.
 *  stage 1  the ground caves in: dust burst + shock ring + radial cracks, a DARK DEPRESSION decal grows over the
 *           whole zone with a rotating sand SWIRL on top, dashed rings spin, sand spirals inward and up.
 *  stage 2  COLLAPSE: big dust cloud + shock rings + crack, flash; the crater decals fade out over ~1.5 s
 *           (they outlive the ultimate on their own timers).
 * Sim ground truth: src/sim/ultimates/mole.ts; timings from `MOLE_VORTEX`.
 */

import * as THREE from 'three';
import { MOLE_VORTEX as K } from '../../config/ultimates/mole';
import { tierProfile } from '../quality';
import type { RibbonHandle, RingHandle, ZoneHandle } from './primitives';
import type { UltFx, UltFxContext } from './types';

const R_ZONE = 4.5;
const DIRT = 0x6b4d30;

interface Slot {
  active: boolean;
  ribbon: RibbonHandle | null;
  zone: ZoneHandle | null;
  ringA: RingHandle | null;
  ringB: RingHandle | null;
  t0: number;
  tOpen: number;
  open: boolean;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  gy: number;
  fromY: number;
  crackAcc: number;
  lastCrackX: number;
  lastCrackZ: number;
  acc: number;
  crater: Crater | null;
}

/** Ground decals of one pit (own timers so the crater outlives the cast). */
interface Crater {
  x: number;
  z: number;
  y: number;
  born: number;
  /** -1 while open; else the render time the collapse / abort started. */
  fadeAt: number;
  dark: THREE.Mesh;
  swirl: THREE.Mesh;
  used: boolean;
}

const slots: Slot[] = [];
const craters: Crater[] = [];
const _p = new THREE.Vector3();

let texDark: THREE.CanvasTexture | null = null;
let texSwirl: THREE.CanvasTexture | null = null;
let discGeo: THREE.BufferGeometry | null = null;

function makeTextures(): void {
  if (texDark !== null) return;
  const S = 256;
  const mk = (): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } => {
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    return { c, g: c.getContext('2d') as CanvasRenderingContext2D };
  };
  {
    const { c, g } = mk();
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(14,8,4,0.95)');
    grad.addColorStop(0.5, 'rgba(28,17,8,0.78)');
    grad.addColorStop(0.82, 'rgba(46,30,15,0.36)');
    grad.addColorStop(1, 'rgba(46,30,15,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    texDark = new THREE.CanvasTexture(c);
  }
  {
    const { c, g } = mk();
    g.translate(S / 2, S / 2);
    g.lineCap = 'round';
    const arms = 4;
    for (let a = 0; a < arms; a++) {
      const th0 = (a / arms) * Math.PI * 2;
      g.beginPath();
      for (let i = 0; i <= 60; i++) {
        const u = i / 60;
        const r = u * (S / 2 - 8);
        const th = th0 + u * 3.6;
        const x = Math.cos(th) * r;
        const y = Math.sin(th) * r;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.strokeStyle = 'rgba(222,190,132,0.6)';
      g.lineWidth = 11;
      g.shadowColor = 'rgba(240,210,150,0.8)';
      g.shadowBlur = 10;
      g.stroke();
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    const mask = g.createRadialGradient(S / 2, S / 2, S * 0.06, S / 2, S / 2, S / 2);
    mask.addColorStop(0, 'rgba(255,255,255,0)');
    mask.addColorStop(0.25, 'rgba(255,255,255,0.9)');
    mask.addColorStop(0.8, 'rgba(255,255,255,0.7)');
    mask.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = mask;
    g.fillRect(0, 0, S, S);
    texSwirl = new THREE.CanvasTexture(c);
  }
  discGeo = new THREE.CircleGeometry(1, 48);
  discGeo.rotateX(-Math.PI / 2);
}

function makeCrater(ctx: UltFxContext): Crater {
  makeTextures();
  const mkMesh = (map: THREE.Texture | null, order: number): THREE.Mesh => {
    const mat = new THREE.MeshBasicMaterial({
      map, transparent: true, depthWrite: false, opacity: 0, fog: false, polygonOffset: true, polygonOffsetFactor: -2 - order, polygonOffsetUnits: -2 - order,
    });
    const m = new THREE.Mesh(discGeo as THREE.BufferGeometry, mat);
    m.frustumCulled = false;
    m.visible = false;
    m.renderOrder = 2 + order;
    ctx.scene.add(m);
    return m;
  };
  return { x: 0, z: 0, y: 0, born: 0, fadeAt: -1, dark: mkMesh(texDark, 0), swirl: mkMesh(texSwirl, 1), used: false };
}

function acquireCrater(ctx: UltFxContext): Crater {
  for (const c of craters) if (!c.used) return c;
  const c = makeCrater(ctx);
  craters.push(c);
  return c;
}

function slot(id: number): Slot {
  let s = slots[id];
  if (s === undefined) {
    s = {
      active: false, ribbon: null, zone: null, ringA: null, ringB: null, t0: 0, tOpen: 0, open: false,
      fromX: 0, fromZ: 0, toX: 0, toZ: 0, gy: 0, fromY: 0, crackAcc: 0, lastCrackX: 0, lastCrackZ: 0, acc: 0, crater: null,
    };
    slots[id] = s;
  }
  return s;
}

const smooth = (u: number): number => u * u * (3 - 2 * u);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function dirtPuff(ctx: UltFxContext, x: number, y: number, z: number, sp: number, up: number, size: number): void {
  const a = Math.random() * Math.PI * 2;
  const s = sp * (0.4 + Math.random() * 0.8);
  const c = 0.85 + Math.random() * 0.3;
  ctx.effects.puff(x, y, z, Math.cos(a) * s, up * (0.6 + Math.random() * 0.8), Math.sin(a) * s, 0.7 + Math.random() * 0.5, size * 0.6, size * 1.6, 0.42 * c, 0.31 * c, 0.19 * c, 0.75, -6, 1.6);
}

function endSlot(id: number, s: Slot): void {
  if (s.ribbon !== null && s.ribbon.held(id)) s.ribbon.hide(0.25);
  if (s.zone !== null && s.zone.held(id)) s.zone.hide(0.3);
  if (s.ringA !== null && s.ringA.held(id)) s.ringA.hide(0.3);
  if (s.ringB !== null && s.ringB.held(id)) s.ringB.hide(0.3);
  s.ribbon = null;
  s.zone = null;
  s.ringA = null;
  s.ringB = null;
  s.active = false;
  s.open = false;
  if (s.crater !== null && s.crater.fadeAt < 0) s.crater.fadeAt = -2; // aborted: fade on the next frame
  s.crater = null;
}

const moleFx: UltFx = {
  onTarget(ctx, ev) {
    if (ev.kind !== 'ground') return;
    const id = ev.fighterId;
    const s = slot(id);
    endSlot(id, s);
    s.active = true;
    s.open = false;
    s.t0 = ctx.time;
    s.fromX = ev.from.x;
    s.fromZ = ev.from.z;
    s.toX = ev.to.x;
    s.toZ = ev.to.z;
    s.gy = ev.to.y;
    s.fromY = ev.from.y;
    s.crackAcc = 0;
    s.lastCrackX = ev.from.x;
    s.lastCrackZ = ev.from.z;
    s.acc = 0;
    const style = ctx.styleFor(id);
    const r = Math.max(1, ev.width * 0.5);
    s.ribbon = ctx.indicators.ribbon(id);
    s.ribbon.show(ev.from.x, ev.from.y, ev.from.z, ev.to.x, ev.to.y, ev.to.z, 0.75, style);
    s.ribbon.setReveal(0);
    s.ribbon.setHead(1);
    s.ribbon.setFlow(7, 0.9);
    s.zone = ctx.indicators.zone(id);
    s.zone.show(ev.to.x, ev.to.y, ev.to.z, r, style);
    s.zone.setProgress(0);

    // Dig-in: dirt spray + dust ring at the launch point.
    const fx = ctx.effects;
    fx.groundDust(ev.from.x, ev.from.z, 1.8, 14);
    const n = Math.max(4, Math.round(16 * tierProfile().fxScale));
    for (let i = 0; i < n; i++) dirtPuff(ctx, ev.from.x, ev.from.y + 0.2, ev.from.z, 2.6, 4.2, 0.28);
    fx.burst({ x: ev.from.x, y: ev.from.y, z: ev.from.z }, DIRT, 8, 3.5, 0.5, 0.12);
    fx.addShake(0.04 * ctx.nearness(ev.from, 16));
  },

  onStage(ctx, ev) {
    const id = ev.fighterId;
    const s = slots[id];
    if (s === undefined || !s.active) return;
    const fx = ctx.effects;
    const pos = { x: s.toX, y: s.gy, z: s.toZ };
    if (ev.stage === 1) {
      s.open = true;
      s.tOpen = ctx.time;
      // The ground caves in.
      const near = ctx.nearness(pos, 24);
      fx.groundDust(pos.x, pos.z, R_ZONE, 30);
      fx.shockRing(pos, 0xd6b47c, 0.6, R_ZONE * 1.05, 0.55, 1.3, 0.85);
      fx.crack(pos.x, pos.z, R_ZONE * 0.85);
      fx.flash(pos, 0.3, 0xffd9a0, 1.4, 5, 0.2, 0.6, 1.3);
      fx.addShake(0.08 * near);
      const n = Math.max(6, Math.round(22 * tierProfile().fxScale));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * R_ZONE;
        dirtPuff(ctx, pos.x + Math.sin(a) * r, pos.y + 0.2, pos.z + Math.cos(a) * r, 1.2, 5, 0.36);
      }
      // The mole surfaces at the rim.
      ctx.fighterPos(id, _p);
      fx.groundDust(_p.x, _p.z, 1.6, 10);
      for (let i = 0; i < 8; i++) dirtPuff(ctx, _p.x, _p.y + 0.2, _p.z, 2, 3.4, 0.24);
      // Zone visuals switch from "warning" to "the pit is open".
      if (s.zone !== null && s.zone.held(id)) {
        s.zone.setProgress(0.45); // the decals below take over; keep just a faint warning tint
        s.zone.setAlpha(0.6);
      }
      if (s.ribbon !== null && s.ribbon.held(id)) {
        s.ribbon.setReveal(1);
        s.ribbon.hide(0.5);
      }
      s.ringA = ctx.indicators.ring(id);
      s.ringA.show(pos.x, pos.y, pos.z, R_ZONE * 0.97, 0.18, ctx.styleFor(id));
      s.ringA.setDash(28, 2.6);
      s.ringB = ctx.indicators.ring(id);
      s.ringB.show(pos.x, pos.y, pos.z, R_ZONE * 0.58, 0.14, ctx.styleFor(id));
      s.ringB.setDash(16, -3.6);
      s.ringB.setAlpha(0.8);
      const c = acquireCrater(ctx);
      c.used = true;
      c.x = pos.x;
      c.z = pos.z;
      c.y = pos.y;
      c.born = ctx.time;
      c.fadeAt = -1;
      c.dark.visible = true;
      c.swirl.visible = true;
      s.crater = c;
      return;
    }
    if (ev.stage === 2) {
      // COLLAPSE.
      const near = ctx.nearness(pos, 26);
      fx.groundDust(pos.x, pos.z, R_ZONE * 1.15, 34);
      fx.shockRing(pos, 0xe6c58a, 0.5, R_ZONE * 1.2, 0.5, 1.5, 0.9);
      fx.shockRing(pos, 0x8a6236, 0.3, R_ZONE * 0.7, 0.35, 1.3, 0.8);
      fx.impactRing(pos, 0.6, 0xffe6bc, 0.5, R_ZONE * 1.1, 0.32, 0.65);
      fx.crack(pos.x, pos.z, R_ZONE);
      fx.flash(pos, 0.5, 0xffc880, 1.6, 6, 0.22, 0.85, 1.6);
      fx.burst(pos, 0xd9b27a, 26, 8.5, 0.6, 0.15);
      const n = Math.max(8, Math.round(30 * tierProfile().fxScale));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * R_ZONE;
        dirtPuff(ctx, pos.x + Math.sin(a) * r, pos.y + 0.2, pos.z + Math.cos(a) * r, 2.5, 7.5, 0.5);
      }
      fx.addShake(0.12 * near);
      if (s.zone !== null && s.zone.held(id)) s.zone.hide(0.25);
      if (s.ringA !== null && s.ringA.held(id)) s.ringA.hide(0.2);
      if (s.ringB !== null && s.ringB.held(id)) s.ringB.hide(0.2);
      if (s.crater !== null) s.crater.fadeAt = ctx.time;
      s.open = false;
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
      const t = ctx.time - s.t0;
      if (!s.open) {
        // Windup: dig, then the crack races out while the mole tunnels under it.
        const u = clamp01((t - K.digS) / K.crackS);
        const reveal = smooth(u);
        if (s.ribbon !== null && s.ribbon.held(id)) {
          s.ribbon.update(s.fromX, s.fromY, s.fromZ, s.toX, s.gy, s.toZ, 0.75);
          s.ribbon.setReveal(reveal);
        }
        if (s.zone !== null && s.zone.held(id)) s.zone.setProgress(clamp01(t / (K.digS + K.crackS)) * 0.9);
        if (t < K.digS) {
          // Digging in: dirt fountain at the launch point.
          s.acc += dt * 50 * q;
          while (s.acc >= 1) {
            s.acc -= 1;
            dirtPuff(ctx, s.fromX, 0.3, s.fromZ, 1.6, 3.6, 0.22);
          }
        } else if (u < 1 && st.ultPhase === 'windup') {
          // Tunnelling: a churn of dirt over the moving mole and crack decals left along the path.
          ctx.fighterPos(id, _p);
          s.acc += dt * 60 * q;
          while (s.acc >= 1) {
            s.acc -= 1;
            dirtPuff(ctx, _p.x, 0.25, _p.z, 1.3, 2.8, 0.2);
          }
          const d = Math.hypot(_p.x - s.lastCrackX, _p.z - s.lastCrackZ);
          if (d > 1.6) {
            fx.crack(_p.x, _p.z, 0.9);
            s.lastCrackX = _p.x;
            s.lastCrackZ = _p.z;
          }
        }
      } else {
        // Vortex: sand spirals round the pit, inward and up.
        const age = ctx.time - s.tOpen;
        s.acc += dt * 70 * q;
        while (s.acc >= 1) {
          s.acc -= 1;
          const th = Math.random() * Math.PI * 2;
          const r = R_ZONE * (0.25 + 0.75 * Math.random());
          const w = 2.6 + (1 - r / R_ZONE) * 3.4; // faster near the centre
          const tx = Math.cos(th) * w * r * 0.55;
          const tz = -Math.sin(th) * w * r * 0.55;
          const px = s.toX + Math.sin(th) * r;
          const pz = s.toZ + Math.cos(th) * r;
          fx.puff(px, s.gy + 0.15, pz, tx - Math.sin(th) * 1.0, 1.4 + Math.random() * 2.4, tz - Math.cos(th) * 1.0, 0.9, 0.22, 0.6, 0.66, 0.53, 0.33, 0.55, -0.8, 1.2);
          if (Math.random() < 0.3) fx.spark(px, s.gy + 0.3, pz, tx * 0.5, 2 + Math.random() * 2, tz * 0.5, 0.6, 0.1, 0.02, 1, 0.86, 0.55, 0.7, -2, 1.5);
        }
        void age;
      }
    }

    // Crater decals (own timers).
    for (const c of craters) {
      if (!c.used) continue;
      if (c.fadeAt === -2) c.fadeAt = ctx.time;
      const age = ctx.time - c.born;
      const grow = easeOut(clamp01(age / 0.45));
      let a = 1;
      if (c.fadeAt >= 0) a = 1 - clamp01((ctx.time - c.fadeAt) / 1.6);
      if (a <= 0.001) {
        c.used = false;
        c.dark.visible = false;
        c.swirl.visible = false;
        continue;
      }
      const r = R_ZONE * (0.15 + 0.85 * grow);
      c.dark.position.set(c.x, c.y + 0.035, c.z);
      c.dark.scale.set(r * 1.06, 1, r * 1.06);
      (c.dark.material as THREE.MeshBasicMaterial).opacity = a * (0.95 * clamp01(age / 0.25));
      c.swirl.position.set(c.x, c.y + 0.05, c.z);
      c.swirl.scale.set(r, 1, r);
      c.swirl.rotation.y = c.fadeAt >= 0 ? c.swirl.rotation.y + dt * 0.8 * a : age * 3.1;
      (c.swirl.material as THREE.MeshBasicMaterial).opacity = a * (c.fadeAt >= 0 ? 0.5 : 0.85);
    }
  },

  onEnd(_ctx, fighterId) {
    const s = slots[fighterId];
    if (s !== undefined) endSlot(fighterId, s);
  },

  dispose() {
    for (const c of craters) {
      c.dark.parent?.remove(c.dark);
      c.swirl.parent?.remove(c.swirl);
      (c.dark.material as THREE.Material).dispose();
      (c.swirl.material as THREE.Material).dispose();
    }
    craters.length = 0;
    slots.length = 0;
    texDark?.dispose();
    texSwirl?.dispose();
    discGeo?.dispose();
    texDark = null;
    texSwirl = null;
    discGeo = null;
  },
};

function easeOut(u: number): number {
  return 1 - Math.pow(1 - u, 3);
}

export default moleFx;
