/**
 * Hippo — Riverlord's Flood VFX (v1.3).
 *
 *  cast     the path RECTANGLE (11 m x 3.4 m) is marked by a ribbon with marching chevrons that reveals along the
 *           path over the windup; while the hippo gapes, blue-white water sparks are sucked toward its maw and
 *           steam puffs from its nostrils.
 *  stage 1  the SLAM: shock ring + crack decals + dust + a fountain at the forefeet; a rolling WAVE CREST (a curled
 *           translucent wall with foam spray and droplets at its head) races down the path at 14 m/s while a MUD
 *           POOL decal is laid out behind it (it follows the real sim growth).
 *  pool     dark mud with a wet sheen and the odd plopping bubble, fading out over the last second of the REAL pool
 *           life (`HIPPO_FLOOD.mudS` from the slam); the decals outlive the ultimate and the caster on their own
 *           timers.
 *  stage 2  the exhale: a soft steam cloud from the maw.
 * Sim ground truth: src/sim/ultimates/hippo.ts + src/sim/groundZones.ts; numbers from `HIPPO_FLOOD`.
 */

import * as THREE from 'three';
import { HIPPO_FLOOD as K, floodSurgeS } from '../../config/ultimates/hippo';
import { tierProfile } from '../quality';
import type { RibbonHandle } from './primitives';
import type { UltFx, UltFxContext } from './types';

const MAX_POOLS = 8;

interface Slot {
  active: boolean;
  ribbon: RibbonHandle | null;
  t0: number;
  windup: number;
  /** Render time of the slam (-1 while winding up). */
  slamAt: number;
  ax: number;
  az: number;
  dx: number;
  dz: number;
  len: number;
  y: number;
  acc: number;
  steam: number;
  wave: THREE.Mesh | null;
}

/** One laid pool: own timers so it outlives the cast, the caster and the slot. */
interface Pool {
  used: boolean;
  mud: THREE.Mesh;
  sheen: THREE.Mesh;
  ax: number;
  az: number;
  dx: number;
  dz: number;
  len: number;
  hw: number;
  y: number;
  born: number;
  growS: number;
  lifeS: number;
  acc: number;
}

const slots: Slot[] = [];
const pools: Pool[] = [];
const _p = new THREE.Vector3();
let lastTime = 0;

let texMud: THREE.CanvasTexture | null = null;
let texSheen: THREE.CanvasTexture | null = null;
let planeGeo: THREE.BufferGeometry | null = null;
let waveGeo: THREE.BufferGeometry | null = null;
let waveMat: THREE.MeshBasicMaterial | null = null;

const smooth = (u: number): number => u * u * (3 - 2 * u);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

// ── Resources ────────────────────────────────────────────────────────────────

function makeTextures(): void {
  if (texMud !== null) return;
  const W = 128;
  const H = 256;
  const mk = (): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return { c, g: c.getContext('2d') as CanvasRenderingContext2D };
  };
  // Edge mask shared by both: soft falloff toward the border of the rectangle, ragged by the blobs below.
  const mask = (g: CanvasRenderingContext2D): void => {
    g.globalCompositeOperation = 'destination-in';
    const gx = g.createLinearGradient(0, 0, W, 0);
    gx.addColorStop(0, 'rgba(255,255,255,0)');
    gx.addColorStop(0.06, 'rgba(255,255,255,1)');
    gx.addColorStop(0.94, 'rgba(255,255,255,1)');
    gx.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gx;
    g.fillRect(0, 0, W, H);
    const gy = g.createLinearGradient(0, 0, 0, H);
    gy.addColorStop(0, 'rgba(255,255,255,0.15)');
    gy.addColorStop(0.06, 'rgba(255,255,255,1)');
    gy.addColorStop(0.94, 'rgba(255,255,255,1)');
    gy.addColorStop(1, 'rgba(255,255,255,0.1)');
    g.fillStyle = gy;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  };
  {
    const { c, g } = mk();
    g.fillStyle = 'rgba(66,43,27,1)';
    g.fillRect(0, 0, W, H);
    // Mottled blobs: darker wet patches and lighter silt.
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const r = 8 + Math.random() * 26;
      const dark = Math.random() < 0.55;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, dark ? 'rgba(28,18,11,0.7)' : 'rgba(118,90,62,0.45)');
      grad.addColorStop(1, dark ? 'rgba(28,18,11,0)' : 'rgba(118,90,62,0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    mask(g);
    texMud = new THREE.CanvasTexture(c);
    texMud.colorSpace = THREE.SRGBColorSpace;
  }
  {
    const { c, g } = mk();
    // Wet sheen: bluish highlights and ripple arcs.
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const rx = 6 + Math.random() * 16;
      const grad = g.createRadialGradient(x, y, 0, x, y, rx);
      grad.addColorStop(0, 'rgba(170,205,215,0.5)');
      grad.addColorStop(1, 'rgba(170,205,215,0)');
      g.fillStyle = grad;
      g.fillRect(x - rx, y - rx, rx * 2, rx * 2);
    }
    g.strokeStyle = 'rgba(190,220,228,0.35)';
    g.lineWidth = 2;
    for (let i = 0; i < 9; i++) {
      g.beginPath();
      g.arc(Math.random() * W, Math.random() * H, 8 + Math.random() * 18, 0, Math.PI * (0.6 + Math.random() * 0.8));
      g.stroke();
    }
    mask(g);
    texSheen = new THREE.CanvasTexture(c);
    texSheen.colorSpace = THREE.SRGBColorSpace;
  }
  planeGeo = new THREE.PlaneGeometry(1, 1);
  planeGeo.rotateX(-Math.PI / 2);
  // Wave crest: a strip along x (unit width) with a rolling, curling profile in (z forward, y up).
  const prof: [number, number][] = [
    [-0.95, 0.0],
    [-0.7, 0.3],
    [-0.4, 0.68],
    [-0.05, 0.95],
    [0.32, 1.0],
    [0.6, 0.8],
    [0.72, 0.5],
    [0.66, 0.22],
    [0.55, 0.05],
  ];
  const NX = 14;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < prof.length; i++) {
    for (let j = 0; j <= NX; j++) {
      const x = j / NX - 0.5;
      pos.push(x, prof[i][1] + Math.sin(j * 1.9 + i) * 0.03, prof[i][0]);
    }
  }
  for (let i = 0; i < prof.length - 1; i++) {
    for (let j = 0; j < NX; j++) {
      const a = i * (NX + 1) + j;
      const b = a + 1;
      const c2 = a + NX + 1;
      const d = c2 + 1;
      idx.push(a, c2, b, b, c2, d);
    }
  }
  waveGeo = new THREE.BufferGeometry();
  waveGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  waveGeo.setIndex(idx);
  waveGeo.computeVertexNormals();
  waveMat = new THREE.MeshBasicMaterial({ color: 0x4fa9c4, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false, fog: false });
}

function makePool(ctx: UltFxContext): Pool {
  makeTextures();
  const mk = (map: THREE.Texture | null, order: number, additive: boolean): THREE.Mesh => {
    const mat = new THREE.MeshBasicMaterial({
      map, transparent: true, depthWrite: false, opacity: 0, fog: false, polygonOffset: true,
      polygonOffsetFactor: -2 - order, polygonOffsetUnits: -2 - order,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const m = new THREE.Mesh(planeGeo as THREE.BufferGeometry, mat);
    m.frustumCulled = false;
    m.visible = false;
    m.renderOrder = 2 + order;
    ctx.scene.add(m);
    return m;
  };
  return { used: false, mud: mk(texMud, 0, false), sheen: mk(texSheen, 1, true), ax: 0, az: 0, dx: 0, dz: 1, len: 1, hw: 1, y: 0, born: 0, growS: 1, lifeS: 1, acc: 0 };
}

function acquirePool(ctx: UltFxContext): Pool {
  for (const p of pools) if (!p.used) return p;
  if (pools.length < MAX_POOLS) {
    const p = makePool(ctx);
    pools.push(p);
    return p;
  }
  // Steal the oldest.
  let o = pools[0];
  for (const p of pools) if (p.born < o.born) o = p;
  return o;
}

function slot(id: number): Slot {
  let s = slots[id];
  if (s === undefined) {
    s = { active: false, ribbon: null, t0: 0, windup: 0.9, slamAt: -1, ax: 0, az: 0, dx: 0, dz: 1, len: 11, y: 0, acc: 0, steam: 0, wave: null };
    slots[id] = s;
  }
  return s;
}

function endSlot(id: number, s: Slot): void {
  if (s.ribbon !== null && s.ribbon.held(id)) s.ribbon.hide(0.25);
  s.ribbon = null;
  if (s.wave !== null) s.wave.visible = false;
  s.active = false;
  s.slamAt = -1;
}

// ── Particle helpers ─────────────────────────────────────────────────────────

function spray(ctx: UltFxContext, x: number, y: number, z: number, vx: number, vz: number, up: number, size: number): void {
  const fx = ctx.effects;
  const c = 0.85 + Math.random() * 0.15;
  fx.puff(x, y, z, vx + rand(-0.8, 0.8), up * rand(0.6, 1.3), vz + rand(-0.8, 0.8), rand(0.45, 0.85), size * 0.6, size * 1.6, 0.74 * c, 0.86 * c, 0.9 * c, 0.5, -5, 1.6);
}

function droplet(ctx: UltFxContext, x: number, y: number, z: number, vx: number, vz: number, up: number): void {
  ctx.effects.spark(x, y, z, vx + rand(-1.2, 1.2), up * rand(0.6, 1.4), vz + rand(-1.2, 1.2), rand(0.4, 0.75), 0.11, 0.03, 0.72, 0.9, 1, 0.85, -14, 0.6);
}

function mudPuff(ctx: UltFxContext, x: number, y: number, z: number, up: number, size: number): void {
  const c = 0.8 + Math.random() * 0.4;
  ctx.effects.puff(x, y, z, rand(-0.5, 0.5), up * rand(0.6, 1.2), rand(-0.5, 0.5), rand(0.5, 0.9), size * 0.6, size * 1.5, 0.3 * c, 0.21 * c, 0.13 * c, 0.6, -4, 1.8);
}

// ── Module ───────────────────────────────────────────────────────────────────

const hippoFx: UltFx = {
  onTarget(ctx, ev) {
    if (ev.kind !== 'line') return;
    const id = ev.fighterId;
    const s = slot(id);
    endSlot(id, s);
    const dx = ev.to.x - ev.from.x;
    const dz = ev.to.z - ev.from.z;
    const len = Math.max(0.5, Math.hypot(dx, dz));
    s.active = true;
    s.t0 = ctx.time;
    s.windup = Math.max(0.3, ev.windup);
    s.slamAt = -1;
    s.ax = ev.from.x;
    s.az = ev.from.z;
    s.dx = dx / len;
    s.dz = dz / len;
    s.len = len;
    s.y = ev.from.y;
    s.acc = 0;
    s.steam = 0;
    // The path rectangle: a chevron ribbon of the full flood width, revealed along the path as the hippo gapes.
    s.ribbon = ctx.indicators.ribbon(id);
    s.ribbon.show(ev.from.x, ev.from.y, ev.from.z, ev.to.x, ev.to.y, ev.to.z, Math.max(1, ev.width), ctx.styleFor(id));
    s.ribbon.setReveal(0);
    s.ribbon.setHead(1);
    s.ribbon.setFlow(6, 1.1);
    // The hippo plants its feet: a dust puff at the start of the path.
    ctx.effects.groundDust(ev.from.x, ev.from.z, 1.6, 8);
  },

  onStage(ctx, ev) {
    const id = ev.fighterId;
    const s = slots[id];
    if (s === undefined || !s.active) return;
    const fx = ctx.effects;
    if (ev.stage === 1) {
      // THE SLAM.
      s.slamAt = ctx.time;
      const px = s.ax + s.dx * 1.7;
      const pz = s.az + s.dz * 1.7;
      const pos = { x: px, y: s.y, z: pz };
      const near = ctx.nearness(pos, 24);
      fx.groundDust(px, pz, 3.6, 26);
      fx.shockRing(pos, 0x9fd6e6, 0.5, 4.2, 0.5, 1.4, 0.9);
      fx.shockRing(pos, 0xe8f4f8, 0.3, 2.6, 0.3, 1.2, 0.8);
      fx.impactRing(pos, 0.5, 0xd8f0f6, 0.5, 3.4, 0.3, 0.6);
      fx.crack(px, pz, 2.4);
      fx.flash(pos, 0.5, 0xbfe6f0, 0.8, 4.6, 0.2, 0.75, 1.5);
      fx.burst(pos, 0xaee0f0, 22, 7, 0.55, 0.13);
      const n = Math.max(6, Math.round(22 * tierProfile().fxScale));
      for (let i = 0; i < n; i++) {
        const a = rand(-0.9, 0.9);
        const sp = rand(1.5, 4);
        spray(ctx, px + rand(-1.4, 1.4), s.y + 0.2, pz + rand(-0.3, 0.3), (s.dx * Math.cos(a) - s.dz * Math.sin(a)) * sp, (s.dz * Math.cos(a) + s.dx * Math.sin(a)) * sp, 4.5, 0.4);
      }
      fx.addShake(0.12 * near);
      // The ribbon has done its job: the wave and the pool take over.
      if (s.ribbon !== null && s.ribbon.held(id)) {
        s.ribbon.setReveal(1);
        s.ribbon.hide(0.35);
      }
      // The pool decals (own timers; they follow the real sim pool: laid over the surge, gone `mudS` after the slam).
      const pool = acquirePool(ctx);
      pool.used = true;
      pool.ax = s.ax;
      pool.az = s.az;
      pool.dx = s.dx;
      pool.dz = s.dz;
      pool.len = s.len;
      pool.hw = K.width * 0.5;
      pool.y = s.y;
      pool.born = ctx.time;
      pool.growS = floodSurgeS(s.len);
      pool.lifeS = K.mudS;
      pool.acc = 0;
      pool.mud.visible = true;
      pool.sheen.visible = true;
      // The wave crest.
      makeTextures();
      if (s.wave === null) {
        const m = new THREE.Mesh(waveGeo as THREE.BufferGeometry, waveMat as THREE.Material);
        m.frustumCulled = false;
        m.renderOrder = 4;
        ctx.scene.add(m);
        s.wave = m;
      }
      s.wave.visible = true;
      return;
    }
    if (ev.stage === 2) {
      // Exhale: a soft steam cloud from the maw.
      ctx.fighterPos(id, _p);
      const yaw = ctx.fighterYaw(id);
      const n = Math.max(3, Math.round(8 * tierProfile().fxScale));
      for (let i = 0; i < n; i++) {
        fx.puff(_p.x + Math.sin(yaw) * 1.9 + rand(-0.3, 0.3), _p.y + 1.0, _p.z + Math.cos(yaw) * 1.9 + rand(-0.3, 0.3), Math.sin(yaw) * rand(0.6, 1.6), rand(0.3, 0.9), Math.cos(yaw) * rand(0.6, 1.6), rand(0.8, 1.2), 0.3, 1.1, 0.9, 0.93, 0.95, 0.4, 0.3, 1.2);
      }
    }
  },

  onFrame(ctx, snapshot, dt) {
    const fx = ctx.effects;
    const q = tierProfile().fxScale;
    if (ctx.time < lastTime - 0.5) resetAll(); // a new match: forget everything
    lastTime = ctx.time;

    for (let id = 0; id < slots.length; id++) {
      const s = slots[id];
      if (s === undefined || !s.active) continue;
      const st = snapshot.fighters[id];
      if (st === undefined) continue;
      const t = ctx.time - s.t0;
      if (s.slamAt < 0) {
        // Windup: the ribbon reveals; water is sucked into the maw, steam from the nostrils.
        if (s.ribbon !== null && s.ribbon.held(id)) s.ribbon.setReveal(smooth(clamp01(t / (s.windup * 0.75))));
        if (t > 0.2) {
          ctx.fighterPos(id, _p);
          const yaw = ctx.fighterYaw(id);
          const mx = _p.x + Math.sin(yaw) * 1.7;
          const mz = _p.z + Math.cos(yaw) * 1.7;
          s.acc += dt * 45 * q;
          while (s.acc >= 1) {
            s.acc -= 1;
            const a = Math.random() * Math.PI * 2;
            const r = rand(1.4, 2.6);
            const sx = mx + Math.cos(a) * r;
            const sz = mz + Math.sin(a) * r;
            const sy = _p.y + rand(0.3, 1.6);
            const k = 3.2;
            fx.spark(sx, sy, sz, (mx - sx) * k, (_p.y + 1.2 - sy) * k, (mz - sz) * k, 0.36, 0.1, 0.03, 0.66, 0.88, 1, 0.8, 0, 0.6);
          }
        }
        s.steam += dt * 14 * q;
        while (s.steam >= 1) {
          s.steam -= 1;
          ctx.fighterPos(id, _p);
          const yaw = ctx.fighterYaw(id);
          const side = Math.random() < 0.5 ? -0.3 : 0.3;
          fx.puff(_p.x + Math.sin(yaw) * 1.7 + Math.cos(yaw) * side, _p.y + 1.25, _p.z + Math.cos(yaw) * 1.7 - Math.sin(yaw) * side, rand(-0.2, 0.2), rand(0.4, 0.9), rand(-0.2, 0.2), 0.7, 0.14, 0.5, 0.92, 0.95, 0.98, 0.3, 0.2, 1.4);
        }
        continue;
      }
      // Surge: the wave crest rolls down the path.
      const ts = ctx.time - s.slamAt;
      const surge = floodSurgeS(s.len);
      const head = Math.min(s.len, K.waveSpeed * ts);
      const hx = s.ax + s.dx * head;
      const hz = s.az + s.dz * head;
      if (s.wave !== null && s.wave.visible) {
        const end = clamp01((ts - surge) / 0.25);
        const grow = smooth(clamp01(ts / 0.12));
        const h = (1.15 - 0.45 * clamp01(head / s.len)) * grow * (1 - end) * (1 + 0.08 * Math.sin(ctx.time * 19));
        s.wave.position.set(hx, s.y, hz);
        s.wave.rotation.y = Math.atan2(s.dx, s.dz);
        s.wave.scale.set(K.width * (0.92 + 0.08 * Math.sin(ctx.time * 11)), Math.max(0.01, h), 0.9 + 0.2 * grow);
        if (end >= 1) s.wave.visible = false;
      }
      if (ts < surge + 0.25) {
        // Foam spray and droplets along the crest, water thrown up ahead, muddy churn behind.
        s.acc += dt * 160 * q;
        while (s.acc >= 1) {
          s.acc -= 1;
          const lat = rand(-K.width * 0.5, K.width * 0.5);
          const px = hx - s.dz * lat;
          const pz = hz + s.dx * lat;
          spray(ctx, px, s.y + 0.8, pz, s.dx * 3, s.dz * 3, 2.6, 0.32);
          if (Math.random() < 0.55) droplet(ctx, px, s.y + 1.0, pz, s.dx * 4.5, s.dz * 4.5, 4.2);
          if (Math.random() < 0.35) mudPuff(ctx, hx - s.dx * rand(0.5, 2.5) - s.dz * lat, s.y + 0.15, hz - s.dz * rand(0.5, 2.5) + s.dx * lat, 1.2, 0.34);
        }
      }
      if (ts > surge + 0.3) {
        s.active = false;
        if (s.wave !== null) s.wave.visible = false;
      }
    }

    // Mud pools: own timers, independent of the slots.
    for (const p of pools) {
      if (!p.used) continue;
      const age = ctx.time - p.born;
      if (age >= p.lifeS) {
        p.used = false;
        p.mud.visible = false;
        p.sheen.visible = false;
        continue;
      }
      const grow = smooth(clamp01(age / p.growS));
      const extent = Math.max(0.05, p.len * grow);
      const cx = p.ax + p.dx * extent * 0.5;
      const cz = p.az + p.dz * extent * 0.5;
      const yaw = Math.atan2(p.dx, p.dz);
      const fade = 1 - clamp01((age - (p.lifeS - K.mudFadeS)) / K.mudFadeS);
      const fadeIn = clamp01(age / 0.18);
      const dry = 1 - 0.12 * clamp01(age / p.lifeS);
      p.mud.position.set(cx, p.y + 0.03, cz);
      p.mud.rotation.y = yaw;
      p.mud.scale.set(p.hw * 2 * 1.06, 1, extent);
      (p.mud.material as THREE.MeshBasicMaterial).opacity = 0.97 * fade * fadeIn * dry;
      p.sheen.position.set(cx, p.y + 0.045, cz);
      p.sheen.rotation.y = yaw;
      p.sheen.scale.set(p.hw * 2, 1, extent);
      (p.sheen.material as THREE.MeshBasicMaterial).opacity = (0.4 - 0.3 * clamp01(age / p.lifeS) + 0.05 * Math.sin(ctx.time * 3 + p.born)) * fade * fadeIn;
      // The odd bubble plopping up out of the laid mud.
      p.acc += dt * 5 * q * fade;
      while (p.acc >= 1) {
        p.acc -= 1;
        const u = Math.random() * extent;
        const lat = rand(-p.hw * 0.85, p.hw * 0.85);
        const bx = p.ax + p.dx * u - p.dz * lat;
        const bz = p.az + p.dz * u + p.dx * lat;
        mudPuff(ctx, bx, p.y + 0.12, bz, 0.9, 0.22);
        if (Math.random() < 0.4) fx.spark(bx, p.y + 0.2, bz, 0, 1.2, 0, 0.3, 0.06, 0.02, 0.5, 0.42, 0.3, 0.6, -6, 1);
      }
    }
  },

  onEnd(_ctx, fighterId) {
    const s = slots[fighterId];
    if (s === undefined) return;
    // The pool and the wave outlive the recovery: only the ribbon is dropped here; an aborted windup clears the slot.
    if (s.ribbon !== null && s.ribbon.held(fighterId)) s.ribbon.hide(0.25);
    s.ribbon = null;
    if (s.slamAt < 0) endSlot(fighterId, s);
  },

  dispose() {
    resetAll();
    for (const p of pools) {
      p.mud.parent?.remove(p.mud);
      p.sheen.parent?.remove(p.sheen);
      (p.mud.material as THREE.Material).dispose();
      (p.sheen.material as THREE.Material).dispose();
    }
    pools.length = 0;
    for (const s of slots) {
      if (s === undefined) continue;
      s.wave?.parent?.remove(s.wave);
    }
    slots.length = 0;
    texMud?.dispose();
    texSheen?.dispose();
    planeGeo?.dispose();
    waveGeo?.dispose();
    waveMat?.dispose();
    texMud = null;
    texSheen = null;
    planeGeo = null;
    waveGeo = null;
    waveMat = null;
  },
};

function resetAll(): void {
  for (const p of pools) {
    p.used = false;
    p.mud.visible = false;
    p.sheen.visible = false;
  }
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s === undefined) continue;
    s.active = false;
    s.slamAt = -1;
    s.ribbon = null;
    if (s.wave !== null) s.wave.visible = false;
  }
}

export default hippoFx;
