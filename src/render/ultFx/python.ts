/**
 * Python — COIL SNARE VFX (v1.3).
 *
 *  cast      lock reticle on the victim (gold for the player, red for others) + a ground ribbon python -> victim
 *            that TRACKS the victim while the python rears and hisses.
 *  COMMIT    the ribbon freezes at the tether's end point and turns solid red, the reticle goes 'committed'.
 *  LASH      the TETHER: a rope of coil links (alternating scale-green / cream) spiralling along the line, flying
 *            out at tether speed with a whip wiggle and a bright tip; the ground ribbon's reveal races with it
 *            (`setReveal`). It is a real moving line: side-step it.
 *  SNARE     snap flash + sparks + ring at the victim; the rope now spans python -> victim and bunches tighter as
 *            the victim is yanked in (dust trail behind the victim).
 *  WRAP 1-4  wrap rings around the victim (2, 3, 4, 5 coils) that TIGHTEN one notch per `ultimateStage`, each beat a
 *            squeeze pulse (rings pinch, ring flash, sparks, dust); a low rope links python and victim.
 *  CRUSH     rings snap shut, then burst outward and fade; flash, sparks, shock ring, ground dust, shake.
 *  WHIFF     the rope snaps back to the python; dust where it ended.
 * Everything is keyed by the caster id. Meshes are built lazily per caster and removed on `dispose`.
 */

import * as THREE from 'three';
import { ANIMALS } from '../../config/animals';
import { PYTHON, PYTHON_STAGE } from '../../config/ultimates/python';
import { clamp } from '../../core/math';
import type { ReticleHandle, RibbonHandle } from './primitives';
import { ARENA } from '../../config/balance';
import { tierProfile } from '../quality';
import type { UltFx, UltFxContext } from './types';

type Mode = 'idle' | 'track' | 'commit' | 'lash' | 'yank' | 'bind' | 'crush' | 'retract';

const LINKS = 30;
const RINGS = 5;
const GREEN = 0x5f8f3c;
const CREAM = 0xdccf98;
const SPARK = 0xcfe27a;

interface Rope {
  mesh: THREE.InstancedMesh;
  tip: THREE.Mesh;
}

interface Ring {
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  rad: number;
  tilt: number;
  dir: number;
}

interface Slot {
  mode: Mode;
  victim: number;
  reticle: ReticleHandle | null;
  ribbon: RibbonHandle | null;
  t0: number;
  windup: number;
  modeT0: number;
  dirX: number;
  dirZ: number;
  ex: number;
  ez: number;
  len: number;
  mine: boolean;
  lvl: number;
  pulse: number;
  acc: number;
  rv: number;
  rope: Rope | null;
  rings: Ring[];
  ringGroup: THREE.Group | null;
  /** Rope tip world point at the moment of a whiff (retract start). */
  tipX: number;
  tipZ: number;
  crushT: number;
}

const slots: Slot[] = [];
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _c = new THREE.Color();
const _ev = { x: 0, y: 0, z: 0 };

let linkGeo: THREE.SphereGeometry | null = null;
let ringGeo: THREE.TorusGeometry | null = null;
let tipGeo: THREE.SphereGeometry | null = null;
let linkMat: THREE.MeshLambertMaterial | null = null;
let tipMat: THREE.MeshBasicMaterial | null = null;
const ownedScenes = new Set<THREE.Scene>();

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

function slot(id: number): Slot {
  let s = slots[id];
  if (s === undefined) {
    s = {
      mode: 'idle', victim: -1, reticle: null, ribbon: null, t0: 0, windup: 0.6, modeT0: 0, dirX: 0, dirZ: 1, ex: 0, ez: 0, len: 8,
      mine: false, lvl: 0, pulse: 0, acc: 0, rv: 1, rope: null, rings: [], ringGroup: null, tipX: 0, tipZ: 0, crushT: 0,
    };
    slots[id] = s;
  }
  return s;
}

function ensureGeo(): void {
  if (linkGeo === null) linkGeo = new THREE.SphereGeometry(1, 6, 4);
  if (ringGeo === null) ringGeo = new THREE.TorusGeometry(1, 0.085, 6, 22);
  if (tipGeo === null) tipGeo = new THREE.SphereGeometry(1, 8, 6);
  if (linkMat === null) linkMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  if (tipMat === null) {
    tipMat = new THREE.MeshBasicMaterial({ color: 0xf4ffb0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  }
}

function ensureRope(ctx: UltFxContext, s: Slot): Rope {
  if (s.rope !== null) return s.rope;
  ensureGeo();
  const mesh = new THREE.InstancedMesh(linkGeo as THREE.SphereGeometry, linkMat as THREE.MeshLambertMaterial, LINKS);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.visible = false;
  for (let i = 0; i < LINKS; i++) mesh.setColorAt(i, _c.setHex(i % 2 === 0 ? GREEN : CREAM));
  if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  const tip = new THREE.Mesh(tipGeo as THREE.SphereGeometry, tipMat as THREE.MeshBasicMaterial);
  tip.frustumCulled = false;
  tip.visible = false;
  ctx.scene.add(mesh);
  ctx.scene.add(tip);
  ownedScenes.add(ctx.scene);
  s.rope = { mesh, tip };
  return s.rope;
}

function ensureRings(ctx: UltFxContext, s: Slot): void {
  if (s.ringGroup !== null) return;
  ensureGeo();
  const g = new THREE.Group();
  g.visible = false;
  for (let i = 0; i < RINGS; i++) {
    const mat = new THREE.MeshLambertMaterial({ color: i % 2 === 0 ? GREEN : CREAM, transparent: true, opacity: 1 });
    const mesh = new THREE.Mesh(ringGeo as THREE.TorusGeometry, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.rotation.order = 'YXZ'; // lie flat (x), spin about the vertical (y), tilt within the plane (z)
    g.add(mesh);
    s.rings.push({ mesh, mat, rad: 2, tilt: 0.08 * (i % 2 === 0 ? 1 : -1) * (1 + i * 0.3), dir: i % 2 === 0 ? 1 : -1 });
  }
  ctx.scene.add(g);
  ownedScenes.add(ctx.scene);
  s.ringGroup = g;
}

function hideRope(s: Slot): void {
  if (s.rope !== null) {
    s.rope.mesh.visible = false;
    s.rope.tip.visible = false;
  }
}

function hideRings(s: Slot): void {
  if (s.ringGroup !== null) s.ringGroup.visible = false;
  for (const r of s.rings) r.mesh.visible = false;
}

function clearMarkers(s: Slot, id: number): void {
  if (s.reticle !== null && s.reticle.held(id)) s.reticle.hide(0.12);
  if (s.ribbon !== null && s.ribbon.held(id)) s.ribbon.hide(0.25);
  s.reticle = null;
  s.ribbon = null;
}

/**
 * Lay `LINKS` coil links along A -> B in a spiral (radius `amp`), `t` is the wiggle clock, `whip` adds a
 * travelling lateral wave (the lash), `thick` scales the links.
 */
function placeRope(rope: Rope, ax: number, ay: number, az: number, bx: number, by: number, bz: number, n: number, amp: number, whip: number, thick: number, t: number): void {
  const count = Math.max(2, Math.min(LINKS, n));
  _d.set(bx - ax, by - ay, bz - az);
  const len = _d.length();
  if (len < 1e-4) {
    rope.mesh.count = 0;
    return;
  }
  _d.multiplyScalar(1 / len);
  // Basis perpendicular to the rope.
  _u.set(-_d.z, 0, _d.x);
  if (_u.lengthSq() < 1e-6) _u.set(1, 0, 0);
  _u.normalize();
  _v.crossVectors(_d, _u).normalize();
  _q.identity();
  for (let i = 0; i < count; i++) {
    const f = i / (count - 1);
    const env = Math.sin(Math.PI * f) * 0.85 + 0.15;
    const ph = i * 1.25 - t * 13;
    const w = Math.sin(i * 0.55 - t * 38) * whip * env;
    const r = amp * env;
    _pos.set(
      ax + _d.x * len * f + _u.x * (Math.cos(ph) * r + w) + _v.x * Math.sin(ph) * r,
      ay + _d.y * len * f + _u.y * (Math.cos(ph) * r + w) + _v.y * Math.sin(ph) * r,
      az + _d.z * len * f + _u.z * (Math.cos(ph) * r + w) + _v.z * Math.sin(ph) * r,
    );
    const sc = thick * (i % 2 === 0 ? 1 : 0.85);
    _s.set(sc, sc, sc * 1.25);
    _m.compose(_pos, _q, _s);
    rope.mesh.setMatrixAt(i, _m);
  }
  rope.mesh.count = count;
  rope.mesh.instanceMatrix.needsUpdate = true;
  rope.tip.position.set(bx, by, bz);
  const ts = thick * 1.9;
  rope.tip.scale.set(ts, ts, ts);
}

function sandPuff(ctx: UltFxContext, x: number, z: number, n: number, sp: number, size: number): void {
  const c = Math.max(1, Math.round(n * fx()));
  for (let i = 0; i < c; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = sp * (0.4 + Math.random() * 0.8);
    ctx.effects.puff(
      x + Math.cos(a) * 0.3, gy(x, z) + 0.12, z + Math.sin(a) * 0.3,
      Math.cos(a) * v, 0.5 + Math.random() * 1.2, Math.sin(a) * v,
      0.5 + Math.random() * 0.4, size * 0.5, size * (1.3 + Math.random() * 0.6),
      0.7, 0.62, 0.42, 0.4, -2, 2.4,
    );
  }
}

const pythonFx: UltFx = {
  onTarget(ctx, ev) {
    if (ev.kind !== 'lock') return;
    const s = slot(ev.fighterId);
    clearMarkers(s, ev.fighterId);
    hideRope(s);
    hideRings(s);
    s.mode = 'track';
    s.victim = ev.targetId;
    s.t0 = ctx.time;
    s.windup = Math.max(0.1, ev.windup);
    s.mine = ctx.isPlayer(ev.fighterId);
    s.lvl = 0;
    s.pulse = 0;
    s.acc = 0;
    const vst = ctx.snapshot.fighters[ev.targetId];
    s.rv = vst !== undefined ? ANIMALS[vst.animal].radius : 1;
    const dx = ev.to.x - ev.from.x;
    const dz = ev.to.z - ev.from.z;
    const l = Math.hypot(dx, dz) || 1;
    s.dirX = dx / l;
    s.dirZ = dz / l;
    s.reticle = ctx.indicators.reticle(ev.fighterId);
    s.reticle.show(ev.to.x, gy(ev.to.x, ev.to.z), ev.to.z, 1.5, s.mine ? 'lock' : 'tracking');
    s.ribbon = ctx.indicators.ribbon(ev.fighterId);
    const ry = segY(ev.from.x, ev.from.z, ev.to.x, ev.to.z);
    s.ribbon.show(ev.from.x, ry, ev.from.z, ev.to.x, ry, ev.to.z, 0.7, ctx.styleFor(ev.fighterId));
    s.ribbon.setFlow(5, 1.0);
  },

  onFrame(ctx, snapshot, dt) {
    for (let id = 0; id < slots.length; id++) {
      const s = slots[id];
      if (s === undefined || s.mode === 'idle') continue;
      if (snapshot.fighters[id] === undefined) continue;
      ctx.fighterPos(id, _a);
      const vOk = s.victim >= 0 && snapshot.fighters[s.victim] !== undefined;
      if (vOk) ctx.fighterPos(s.victim, _b);
      const t = ctx.time;

      if (s.mode === 'track' || s.mode === 'commit') {
        if (s.reticle !== null && s.reticle.held(id) && vOk) {
          s.reticle.update(_b.x, gy(_b.x, _b.z), _b.z, 1.5);
          if (s.mode === 'commit') s.reticle.setCommit(Math.min(1, (t - s.modeT0) / Math.max(0.05, s.windup * (1 - PYTHON.commitFrac))));
        }
        if (s.ribbon !== null && s.ribbon.held(id)) {
          if (s.mode === 'track' && vOk) {
            const dx = _b.x - _a.x;
            const dz = _b.z - _a.z;
            const l = Math.hypot(dx, dz) || 1;
            s.dirX = dx / l;
            s.dirZ = dz / l;
            const ry = segY(_a.x, _a.z, _b.x, _b.z);
            s.ribbon.update(_a.x, ry, _a.z, _b.x, ry, _b.z, 0.7);
          } else {
            const ry = segY(_a.x, _a.z, s.ex, s.ez);
            s.ribbon.update(_a.x, ry, _a.z, s.ex, ry, s.ez, 0.7);
          }
        }
      } else if (s.mode === 'lash' && s.rope !== null) {
        const tip = Math.min(s.len, PYTHON.tetherSpeed * (t - s.modeT0));
        const f = tip / Math.max(0.1, s.len);
        const ox = _a.x + s.dirX * 0.9;
        const oz = _a.z + s.dirZ * 0.9;
        const tx = _a.x + s.dirX * (0.5 + tip);
        const tz = _a.z + s.dirZ * (0.5 + tip);
        const ty = 1.25 - 0.5 * Math.min(1, tip / 4);
        placeRope(s.rope, ox, _a.y + 1.3, oz, tx, gy(tx, tz) + ty, tz, Math.round(6 + 24 * f), 0.11, 0.22 * (1 - f * 0.8), 0.11, t);
        s.rope.mesh.visible = true;
        s.rope.tip.visible = true;
        if (s.ribbon !== null && s.ribbon.held(id)) s.ribbon.setReveal(f);
        s.acc += dt;
        if (s.acc > 0.03) {
          s.acc = 0;
          ctx.effects.spark(tx, ty, tz, (Math.random() - 0.5) * 1.5, 0.5 + Math.random(), (Math.random() - 0.5) * 1.5, 0.25, 0.1, 0.02, 0.85, 1, 0.5, 0.8, -6, 2);
        }
      } else if (s.mode === 'yank' && s.rope !== null && vOk) {
        const ox = _a.x + s.dirX * 0.9;
        const oz = _a.z + s.dirZ * 0.9;
        const dist = Math.hypot(_b.x - ox, _b.z - oz);
        const f = clamp(dist / 8, 0.1, 1);
        placeRope(s.rope, ox, _a.y + 1.2, oz, _b.x, _b.y + 0.8, _b.z, Math.round(10 + 18 * f), 0.1 + 0.1 * (1 - f), 0.05, 0.11, t);
        s.rope.mesh.visible = true;
        s.rope.tip.visible = true;
        s.acc += dt;
        if (s.acc > 0.04) {
          s.acc = 0;
          sandPuff(ctx, _b.x, _b.z, 2, 2.2, 0.55);
        }
      } else if (s.mode === 'bind' && vOk) {
        s.pulse *= Math.exp(-dt * 5);
        if (s.rope !== null) {
          placeRope(s.rope, _a.x + s.dirX * 0.3, _a.y + 0.5, _a.z + s.dirZ * 0.3, _b.x, _b.y + 0.45, _b.z, 12, 0.13 + 0.05 * s.pulse, 0, 0.14, t);
          s.rope.mesh.visible = true;
          s.rope.tip.visible = false;
        }
        updateRings(s, dt, _b.x, _b.y, _b.z, t);
      } else if (s.mode === 'crush') {
        s.crushT += dt;
        updateRings(s, dt, _b.x, _b.y, _b.z, t);
        if (s.crushT > 0.35) {
          hideRings(s);
          s.mode = 'idle';
        }
      } else if (s.mode === 'retract' && s.rope !== null) {
        const k = clamp((t - s.modeT0) / PYTHON.retractT, 0, 1);
        const e = 1 - (1 - k) * (1 - k) * (1 - k);
        const ox = _a.x + s.dirX * 0.9;
        const oz = _a.z + s.dirZ * 0.9;
        const tx = s.tipX + (ox - s.tipX) * e;
        const tz = s.tipZ + (oz - s.tipZ) * e;
        placeRope(s.rope, ox, _a.y + 1.3, oz, tx, gy(tx, tz) + 0.75 + 0.5 * e, tz, Math.round(30 - 22 * e), 0.11 + 0.05 * e, 0.12, 0.11, t);
        s.rope.tip.visible = k < 0.9;
        if (k >= 1) {
          hideRope(s);
          s.mode = 'idle';
        }
      }
    }
  },

  onStage(ctx, ev) {
    const id = ev.fighterId;
    const s = slot(id);
    const near = ctx.nearness(ev.pos, 16);
    switch (ev.stage) {
      case PYTHON_STAGE.COMMIT: {
        s.mode = 'commit';
        s.modeT0 = ctx.time;
        s.ex = ev.pos.x;
        s.ez = ev.pos.z;
        ctx.fighterPos(id, _a);
        const dx = ev.pos.x - _a.x;
        const dz = ev.pos.z - _a.z;
        const l = Math.hypot(dx, dz) || 1;
        s.dirX = dx / l;
        s.dirZ = dz / l;
        s.len = l;
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
      case PYTHON_STAGE.LASH: {
        ensureRope(ctx, s);
        s.mode = 'lash';
        s.modeT0 = ctx.time;
        s.acc = 0;
        s.ex = ev.pos.x;
        s.ez = ev.pos.z;
        ctx.fighterPos(id, _a);
        const dx = ev.pos.x - _a.x;
        const dz = ev.pos.z - _a.z;
        s.len = Math.max(1, Math.hypot(dx, dz) - 0.5);
        _ev.x = _a.x + s.dirX * 0.9;
        _ev.y = _a.y + 1.3;
        _ev.z = _a.z + s.dirZ * 0.9;
        ctx.effects.flash(_ev, 0, 0xe9f7a0, 0.3, 1.6, 0.14, 0.8, 1.6);
        ctx.effects.burst(_ev, SPARK, 8, 4.5, 0.3, 0.1);
        ctx.effects.addShake(0.04 * near);
        if (s.ribbon !== null && s.ribbon.held(id)) {
          const ry = segY(_a.x, _a.z, s.ex, s.ez);
          s.ribbon.update(_a.x, ry, _a.z, s.ex, ry, s.ez, 0.7);
          s.ribbon.setReveal(0);
        }
        if (s.reticle !== null && s.reticle.held(id)) s.reticle.hide(0.12);
        s.reticle = null;
        break;
      }
      case PYTHON_STAGE.SNARE: {
        s.mode = 'yank';
        s.modeT0 = ctx.time;
        s.acc = 0;
        _ev.x = ev.pos.x;
        _ev.y = gy(ev.pos.x, ev.pos.z);
        _ev.z = ev.pos.z;
        ctx.effects.flash(ev.pos, 0.8, 0xeaffb0, 0.5, 2.6, 0.22, 0.9, 1.7);
        ctx.effects.burst(ev.pos, SPARK, 18, 6.5, 0.4, 0.12);
        ctx.effects.shockRing(_ev, 0x9cc860, 0.3, 2.3, 0.3, 1.2, 0.8);
        ctx.effects.addShake(0.1 * near);
        if (s.ribbon !== null && s.ribbon.held(id)) s.ribbon.hide(0.2);
        s.ribbon = null;
        break;
      }
      case PYTHON_STAGE.WRAP1:
      case PYTHON_STAGE.WRAP2:
      case PYTHON_STAGE.WRAP3:
      case PYTHON_STAGE.WRAP4: {
        const lvl = ev.stage - PYTHON_STAGE.WRAP1 + 1;
        ensureRope(ctx, s);
        ensureRings(ctx, s);
        if (s.mode !== 'bind') {
          s.mode = 'bind';
          s.modeT0 = ctx.time;
          s.crushT = 0;
          const vst = ctx.snapshot.fighters[ev.targetId];
          if (vst !== undefined) s.rv = ANIMALS[vst.animal].radius;
          s.victim = ev.targetId >= 0 ? ev.targetId : s.victim;
          for (const r of s.rings) {
            r.rad = s.rv * 1.9;
            r.mat.opacity = 1;
          }
          if (s.ringGroup !== null) s.ringGroup.visible = true;
        }
        s.lvl = lvl;
        s.pulse = 1;
        _ev.x = ev.pos.x;
        _ev.y = gy(ev.pos.x, ev.pos.z);
        _ev.z = ev.pos.z;
        ctx.effects.impactRing(ev.pos, 0.7, 0xc6e07a, 0.35, 1.5 + 0.1 * lvl, 0.28, 0.65);
        ctx.effects.burst(ev.pos, SPARK, 5 + lvl * 2, 3.5, 0.3, 0.09);
        sandPuff(ctx, ev.pos.x, ev.pos.z, 3 + lvl, 2.2, 0.5);
        ctx.effects.addShake((0.03 + 0.012 * lvl) * near);
        break;
      }
      case PYTHON_STAGE.CRUSH: {
        s.mode = 'crush';
        s.crushT = 0;
        hideRope(s);
        _ev.x = ev.pos.x;
        _ev.y = gy(ev.pos.x, ev.pos.z);
        _ev.z = ev.pos.z;
        ctx.effects.flash(ev.pos, 0.8, 0xeaffb0, 0.7, 3.0, 0.26, 0.9, 1.7);
        ctx.effects.burst(ev.pos, SPARK, 26, 8, 0.5, 0.13);
        ctx.effects.shockRing(_ev, 0x9cc860, 0.5, 3.6, 0.45, 1.3, 0.85);
        ctx.effects.groundDust(ev.pos.x, ev.pos.z, 3, 20);
        ctx.effects.addShake(0.17 * near);
        break;
      }
      case PYTHON_STAGE.WHIFF: {
        s.mode = 'retract';
        s.modeT0 = ctx.time;
        s.tipX = ev.pos.x;
        s.tipZ = ev.pos.z;
        clearMarkers(s, id);
        if (s.rope === null) ensureRope(ctx, s);
        if (s.rope !== null) s.rope.mesh.visible = true;
        ctx.effects.groundDust(ev.pos.x, ev.pos.z, 1.6, 10);
        break;
      }
      default:
        break;
    }
  },

  onEnd(_ctx, fighterId) {
    const s = slots[fighterId];
    if (s === undefined) return;
    if (s.mode === 'crush' && s.crushT < 0.35) {
      // Let the crush burst finish; the frame loop hides the rings.
      hideRope(s);
    } else {
      hideRope(s);
      hideRings(s);
      s.mode = 'idle';
    }
    s.victim = s.mode === 'idle' ? -1 : s.victim;
    s.reticle = null;
    s.ribbon = null;
  },

  dispose() {
    for (const s of slots) {
      if (s === undefined) continue;
      if (s.rope !== null) {
        s.rope.mesh.removeFromParent();
        s.rope.mesh.dispose();
        s.rope.tip.removeFromParent();
      }
      if (s.ringGroup !== null) {
        s.ringGroup.removeFromParent();
        for (const r of s.rings) r.mat.dispose();
      }
    }
    slots.length = 0;
    linkGeo?.dispose();
    ringGeo?.dispose();
    tipGeo?.dispose();
    linkMat?.dispose();
    tipMat?.dispose();
    linkGeo = null;
    ringGeo = null;
    tipGeo = null;
    linkMat = null;
    tipMat = null;
    ownedScenes.clear();
  },
};

/** Place / animate the wrap rings around the victim. */
function updateRings(s: Slot, dt: number, x: number, y: number, z: number, t: number): void {
  if (s.ringGroup === null) return;
  const crushing = s.mode === 'crush';
  const n = Math.min(RINGS, 1 + s.lvl);
  const hv = clamp(s.rv, 0.7, 1.4);
  for (let i = 0; i < RINGS; i++) {
    const r = s.rings[i];
    if (i >= n) {
      r.mesh.visible = false;
      continue;
    }
    r.mesh.visible = true;
    let target = Math.max(0.42, s.rv * (1.12 - 0.11 * s.lvl));
    if (crushing) {
      // Snap shut for the first 0.06 s, then burst outward and fade.
      const k = s.crushT;
      target = k < 0.06 ? target * 0.72 : target * (0.72 + (k - 0.06) * 14);
      r.mat.opacity = k < 0.06 ? 1 : Math.max(0, 1 - (k - 0.06) / 0.28);
    } else target *= 1 - 0.16 * s.pulse;
    r.rad += (target - r.rad) * (1 - Math.exp(-dt * (crushing ? 40 : 16)));
    const yy = y + (0.22 + i * 0.23) * hv;
    const thick = (0.9 + 0.12 * s.lvl) * (crushing && s.crushT > 0.06 ? 1 : 1);
    r.mesh.position.set(x, yy, z);
    r.mesh.rotation.set(Math.PI / 2 + r.tilt * Math.sin(t * 2 + i), t * 0.6 * r.dir + i, r.tilt * Math.cos(t * 1.7 + i));
    r.mesh.scale.set(r.rad, r.rad, thick * (0.9 + 0.25 * Math.sin(t * 9 + i) * s.pulse + 0.25));
  }
}

export default pythonFx;
