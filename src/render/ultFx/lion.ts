/**
 * Lion — Royal Hunt VFX (v1.3 Phase 2). Indicators + effects for the lock-on pounce and maul:
 *  - cast: a reticle tracks the victim (gold for the player's own hunt, red for an enemy's) with a dashed
 *    arc showing the pounce path; at take-off the reticle commits (solid) and the arc fades; at touchdown both go.
 *  - stage 1 take-off dust · 2 touchdown (shock ring, dust, crack, sparks, shake) · 3..6 claw-slash streaks on
 *    the victim (R rake, L rake, bite fangs, X double slam) timed to the claws landing · 7 roar (sound rings
 *    rolling out of the jaws, gold shock, shake).
 *  - the MARK (+20% damage taken, 6 s): a pulsing ground ring, a glowing aura shell and a floating claw glyph
 *    on the victim for as long as the `dmgTakenUp` buff lasts, with embers rising off them.
 * Also exports {@link SlashPool}, the pooled camera-facing claw-streak quads the panther module reuses.
 */

import * as THREE from 'three';
import { ANIMALS } from '../../config/animals';
import { LION_HUNT as H } from '../../config/ultimates/lion';
import type { Vec3, WorldSnapshot } from '../../core/types';
import { tierProfile } from '../quality';
import type { ArcHandle, ReticleHandle, RingHandle } from './primitives';
import type { UltFx, UltFxContext } from './types';

// ── Shared: claw-streak quads ────────────────────────────────────────────────

let clawTexture: THREE.CanvasTexture | null = null;

/** Three tapered parallel streaks on a transparent canvas (lazy: the module must import cleanly under node). */
export function getClawTexture(): THREE.CanvasTexture {
  if (clawTexture !== null) return clawTexture;
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 128;
  const g = cv.getContext('2d');
  if (g !== null) {
    for (let i = -1; i <= 1; i++) {
      const y0 = 64 + i * 27;
      const grad = g.createLinearGradient(14, 0, 244, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.18, 'rgba(255,255,255,1)');
      grad.addColorStop(0.75, 'rgba(255,255,255,0.85)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      const steps = 24;
      for (let s = 0; s <= steps; s++) {
        const x = 14 + (230 * s) / steps;
        const w = Math.sin((Math.PI * s) / steps) * 7.5 + 0.6;
        const y = y0 - 16 * Math.sin((Math.PI * s) / steps) - 8 * (s / steps);
        if (s === 0) g.moveTo(x, y - w);
        else g.lineTo(x, y - w);
      }
      for (let s = steps; s >= 0; s--) {
        const x = 14 + (230 * s) / steps;
        const w = Math.sin((Math.PI * s) / steps) * 7.5 + 0.6;
        const y = y0 - 16 * Math.sin((Math.PI * s) / steps) - 8 * (s / steps);
        g.lineTo(x, y + w);
      }
      g.closePath();
      g.fill();
    }
  }
  clawTexture = new THREE.CanvasTexture(cv);
  clawTexture.colorSpace = THREE.SRGBColorSpace;
  return clawTexture;
}

export function disposeClawTexture(): void {
  if (clawTexture !== null) clawTexture.dispose();
  clawTexture = null;
}

const SLASH_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const SLASH_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uReveal;
uniform float uFade;
uniform vec3 uTint;
uniform vec3 uCore;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float m = smoothstep(uReveal, uReveal - 0.3, vUv.x);
  float a = t.a * m * uFade;
  if (a < 0.01) discard;
  vec3 col = mix(uTint, uCore, t.r * t.r) * (0.7 + 1.1 * t.r);
  gl_FragColor = vec4(col, a);
}
`;

export function makeSlashMaterial(tint: number, core: number, additive = true): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: getClawTexture() },
      uReveal: { value: 1 },
      uFade: { value: 1 },
      uTint: { value: new THREE.Color(tint) },
      uCore: { value: new THREE.Color(core) },
    },
    vertexShader: SLASH_VERT,
    fragmentShader: SLASH_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false, // streaks sit on the victim's body: draw over it
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
}

interface Slash {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  age: number;
  ttl: number;
  roll: number;
  active: boolean;
}

/** Pool of camera-facing claw-streak quads that sweep in (reveal) and fade out. */
export class SlashPool {
  private readonly items: Slash[] = [];
  private readonly geo = new THREE.PlaneGeometry(1, 0.5);
  private next = 0;

  constructor(
    private readonly scene: THREE.Scene,
    count: number,
    private readonly tint: number,
    core: number,
    additive = true,
  ) {
    for (let i = 0; i < count; i++) {
      const mat = makeSlashMaterial(tint, core, additive);
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      scene.add(mesh);
      this.items.push({ mesh, mat, age: 0, ttl: 1, roll: 0, active: false });
    }
  }

  /** Spawn a streak at a world point; `roll` (rad) spins it about the view axis, `w`×`w/2` metres. */
  spawn(x: number, y: number, z: number, roll: number, w: number, ttl = 0.3, tint?: number): void {
    const s = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    s.active = true;
    s.age = 0;
    s.ttl = ttl;
    s.roll = roll;
    s.mesh.position.set(x, y, z);
    s.mesh.scale.set(w, w, 1);
    s.mesh.visible = true;
    if (tint !== undefined) (s.mat.uniforms.uTint.value as THREE.Color).setHex(tint);
    else (s.mat.uniforms.uTint.value as THREE.Color).setHex(this.tint);
    s.mat.uniforms.uReveal.value = 0;
    s.mat.uniforms.uFade.value = 1;
  }

  update(camera: THREE.Camera, dt: number): void {
    for (const s of this.items) {
      if (!s.active) continue;
      s.age += dt;
      const k = s.age / s.ttl;
      if (k >= 1) {
        s.active = false;
        s.mesh.visible = false;
        continue;
      }
      // Sweep in over the first 35% (ease-out), then hold and fade.
      const reveal = Math.min(1, k / 0.35);
      s.mat.uniforms.uReveal.value = 1 - Math.pow(1 - reveal, 3) + 0.3 * (1 - reveal);
      s.mat.uniforms.uFade.value = k < 0.4 ? 1 : 1 - (k - 0.4) / 0.6;
      s.mesh.quaternion.copy(camera.quaternion);
      s.mesh.rotateZ(s.roll);
    }
  }

  dispose(): void {
    for (const s of this.items) {
      this.scene.remove(s.mesh);
      s.mat.dispose();
    }
    this.items.length = 0;
    this.geo.dispose();
  }
}

// ── Lion module state ────────────────────────────────────────────────────────

interface Slot {
  reticle: ReticleHandle | null;
  arc: ArcHandle | null;
  targetId: number;
  t0: number;
  lead: number;
  startX: number;
  startZ: number;
  nextDust: number;
}

interface Mark {
  ring: RingHandle | null;
  aura: THREE.Mesh | null;
  glyph: THREE.Mesh | null;
  glyphMat: THREE.ShaderMaterial | null;
  on: boolean;
  age: number;
  nextEmber: number;
}

interface Pending {
  at: number;
  run: () => void;
}

const slots: Slot[] = [];
const marks: Mark[] = [];
const pending: Pending[] = [];
let pool: SlashPool | null = null;
let auraGeo: THREE.SphereGeometry | null = null;
let glyphGeo: THREE.PlaneGeometry | null = null;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _auraMats: THREE.MeshBasicMaterial[] = [];

function ensurePool(ctx: UltFxContext): SlashPool {
  if (pool === null) pool = new SlashPool(ctx.scene, 10, 0xff8a30, 0xfff0c8);
  return pool;
}

function slot(id: number): Slot {
  let s = slots[id];
  if (s === undefined) {
    s = { reticle: null, arc: null, targetId: -1, t0: 0, lead: 1, startX: 0, startZ: 0, nextDust: 0 };
    slots[id] = s;
  }
  return s;
}

function later(ctx: UltFxContext, delay: number, run: () => void): void {
  pending.push({ at: ctx.time + delay, run });
}

function dust(ctx: UltFxContext, x: number, y: number, z: number, n: number, spread = 0.5): void {
  const k = tierProfile().fxScale;
  const count = Math.max(1, Math.round(n * k));
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 0.4 + Math.random() * spread * 2;
    ctx.effects.puff(x + Math.cos(a) * 0.3, y, z + Math.sin(a) * 0.3, Math.cos(a) * sp, 0.4 + Math.random() * 0.8, Math.sin(a) * sp, 0.55 + Math.random() * 0.35, 0.35, 1.1, 0.78, 0.66, 0.46, 0.4, -0.6, 2.2);
  }
}

/** Claw streaks across the victim for strike `stage` (3..6), timed by the caller. */
function clawSlash(ctx: UltFxContext, stage: number, at: Vec3, yaw: number): void {
  const p = ensurePool(ctx);
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const y = at.y + 0.75;
  // Pull the streaks slightly toward the lion so they sit on the victim's near flank.
  const x = at.x - fx * 0.35;
  const z = at.z - fz * 0.35;
  if (stage === 3) p.spawn(x, y, z, 0.55, 1.9, 0.32);
  else if (stage === 4) p.spawn(x, y, z, Math.PI - 0.55, 1.9, 0.32);
  else if (stage === 5) {
    // Bite: two short fang marks converging.
    p.spawn(x, y + 0.2, z, 1.25, 1.1, 0.3, 0xfff0c8);
    p.spawn(x, y - 0.2, z, -1.25, 1.1, 0.3, 0xfff0c8);
  } else {
    // Double-claw slam: an X of rakes, bigger.
    p.spawn(x, y, z, 0.7, 2.3, 0.36);
    p.spawn(x, y, z, Math.PI - 0.7, 2.3, 0.36);
  }
  ctx.effects.burst({ x: at.x, y: at.y + 0.3, z: at.z }, stage === 7 ? 0xffc060 : 0xff6a30, stage >= 5 ? 14 : 9, 5.5, 0.4, 0.12);
  ctx.effects.flash(at, 0.8, 0xff7a2a, 0.6, 2.1, 0.14, 0.7, 1.4);
}

// ── Marks ────────────────────────────────────────────────────────────────────

function markOf(id: number): Mark {
  let m = marks[id];
  if (m === undefined) {
    m = { ring: null, aura: null, glyph: null, glyphMat: null, on: false, age: 0, nextEmber: 0 };
    marks[id] = m;
  }
  return m;
}

function updateMarks(ctx: UltFxContext, snap: WorldSnapshot, dt: number): void {
  for (let id = 0; id < snap.fighters.length; id++) {
    const f = snap.fighters[id];
    let buff: { t: number; dur: number; mag: number } | undefined;
    if (f.alive) for (let i = 0; i < f.buffs.length; i++) if (f.buffs[i].kind === 'dmgTakenUp' && f.buffs[i].mag >= 0.15) buff = f.buffs[i];
    const m = markOf(id);
    if (buff === undefined) {
      if (m.on) endMark(m);
      continue;
    }
    const r = ANIMALS[f.animal].radius;
    ctx.fighterPos(id, _a);
    if (!m.on) {
      m.on = true;
      m.age = 0;
      m.ring = ctx.indicators.ring(); // no owner: outlives the ultimate; released in endMark
      m.ring.show(_a.x, 0, _a.z, r * 1.7 + 0.35, 0.13, 'friendly');
      m.ring.setColor(0xffa838);
      m.ring.setDash(12, 1.2);
      m.ring.setGlow(1);
      if (auraGeo === null) auraGeo = new THREE.SphereGeometry(1, 18, 12);
      if (glyphGeo === null) glyphGeo = new THREE.PlaneGeometry(1, 0.5);
      if (m.aura === null) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xff9a2a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
        _auraMats.push(mat);
        m.aura = new THREE.Mesh(auraGeo, mat);
        m.aura.frustumCulled = false;
        m.aura.renderOrder = 5;
        ctx.scene.add(m.aura);
      }
      if (m.glyph === null) {
        m.glyphMat = makeSlashMaterial(0xff8a30, 0xfff0c8);
        m.glyph = new THREE.Mesh(glyphGeo, m.glyphMat);
        m.glyph.frustumCulled = false;
        m.glyph.renderOrder = 7;
        ctx.scene.add(m.glyph);
      }
      m.aura.visible = true;
      m.glyph.visible = true;
    }
    m.age += dt;
    const left = buff.dur - buff.t;
    const inK = Math.min(1, m.age / 0.3);
    const outK = Math.min(1, Math.max(0, left / 0.6));
    const k = inK * outK;
    const pulse = 0.5 + 0.5 * Math.sin(ctx.time * 5.2);
    if (m.ring !== null) {
      if (m.ring.active) {
        m.ring.update(_a.x, 0, _a.z, r * 1.7 + 0.35 + 0.08 * pulse);
        m.ring.setAlpha(k);
      } else m.ring = null;
    }
    if (m.aura !== null) {
      const rad = r * 1.35 + 0.15 + 0.06 * pulse;
      m.aura.position.set(_a.x, _a.y + 0.55 + r * 0.5, _a.z);
      m.aura.scale.set(rad, rad * 0.95, rad);
      (m.aura.material as THREE.MeshBasicMaterial).opacity = (0.09 + 0.07 * pulse) * k;
    }
    if (m.glyph !== null && m.glyphMat !== null) {
      const h = 1.9 + r * 1.3 + 0.08 * Math.sin(ctx.time * 3.1);
      m.glyph.position.set(_a.x, _a.y + h, _a.z);
      m.glyph.quaternion.copy(ctx.camera.quaternion);
      m.glyph.rotateZ(0.5);
      m.glyph.scale.set(0.95, 0.95, 1);
      m.glyphMat.uniforms.uFade.value = (0.55 + 0.45 * pulse) * k;
    }
    // Embers rising off the marked body.
    if (ctx.time >= m.nextEmber && k > 0.3) {
      m.nextEmber = ctx.time + 0.14 / Math.max(0.4, tierProfile().fxScale);
      const a = Math.random() * Math.PI * 2;
      ctx.effects.spark(_a.x + Math.cos(a) * r, _a.y + 0.25 + Math.random() * 0.7, _a.z + Math.sin(a) * r, 0, 1.3 + Math.random(), 0, 0.85, 0.11, 0.02, 1, 0.55, 0.15, 0.9, -0.4, 1.2);
    }
  }
}

function endMark(m: Mark): void {
  m.on = false;
  if (m.ring !== null && m.ring.active) m.ring.hide(0.3);
  m.ring = null;
  if (m.aura !== null) m.aura.visible = false;
  if (m.glyph !== null) m.glyph.visible = false;
}

// ── The UltFx module ─────────────────────────────────────────────────────────

const lionFx: UltFx = {
  onTarget(ctx, ev) {
    if (ev.kind !== 'lock') return;
    const s = slot(ev.fighterId);
    s.targetId = ev.targetId;
    s.t0 = ctx.time;
    s.lead = Math.max(0.2, ev.windup);
    s.startX = ev.from.x;
    s.startZ = ev.from.z;
    s.nextDust = ctx.time + 0.1;
    const mine = ctx.isPlayer(ev.fighterId);
    s.reticle = ctx.indicators.reticle(ev.fighterId);
    s.reticle.show(ev.to.x, 0, ev.to.z, 1.6, mine ? 'lock' : 'tracking');
    s.arc = ctx.indicators.arc(ev.fighterId);
    s.arc.show(ev.from.x, 0.9, ev.from.z, ev.to.x, 0.9, ev.to.z, 2.6, 0.26, ctx.styleFor(ev.fighterId));
    s.arc.setDash(0.6, 2.4);
  },

  onStage(ctx, ev) {
    const st = ev.stage;
    const lion = ctx.fighterPos(ev.fighterId, _a);
    if (st === H.stage.leap) {
      dust(ctx, lion.x, 0.2, lion.z, 12, 0.9);
      ctx.effects.shockRing({ x: lion.x, y: 0, z: lion.z }, 0xd9a441, 0.4, 2.2, 0.3, 1.1, 0.7);
      ctx.effects.addShake(0.03 * ctx.nearness(ev.pos, 14));
    } else if (st === H.stage.pin) {
      ctx.effects.shockRing({ x: ev.pos.x, y: 0, z: ev.pos.z }, 0xffc860, 0.5, 3.4, 0.4, 1.4, 0.9);
      ctx.effects.groundDust(ev.pos.x, ev.pos.z, 2.6, 18);
      ctx.effects.crack(ev.pos.x, ev.pos.z, 1.5);
      ctx.effects.burst({ x: ev.pos.x, y: 0.1, z: ev.pos.z }, 0xffc060, 18, 6, 0.5, 0.14);
      ctx.effects.flash({ x: ev.pos.x, y: 0, z: ev.pos.z }, 0.5, 0xffd890, 0.8, 3.2, 0.2, 0.75, 1.5);
      const near = ctx.nearness(ev.pos, 16);
      ctx.effects.addShake(0.11 * near);
    } else if (st >= H.stage.strike0 && st < H.stage.roar) {
      // The claws land `impactDelay` after the beat starts.
      const yaw = ctx.fighterYaw(ev.fighterId);
      const at: Vec3 = { x: ev.pos.x, y: ev.pos.y, z: ev.pos.z };
      later(ctx, H.impactDelay, () => {
        clawSlash(ctx, st, at, yaw);
        ctx.effects.addShake((st >= 5 ? 0.07 : 0.045) * ctx.nearness(at, 14));
      });
    } else if (st === H.stage.roar) {
      const yaw = ctx.fighterYaw(ev.fighterId);
      const lx = lion.x;
      const ly = lion.y;
      const lz = lion.z;
      const hx = lx + Math.sin(yaw) * 0.9;
      const hz = lz + Math.cos(yaw) * 0.9;
      const hy = ly + 1.7;
      const at: Vec3 = { x: ev.pos.x, y: ev.pos.y, z: ev.pos.z };
      later(ctx, H.roarImpactDelay - 0.08, () => {
        for (let i = 0; i < 3; i++) later(ctx, i * 0.11, () => ctx.effects.impactRing({ x: hx, y: 0, z: hz }, hy, 0xffd27a, 0.3, 3.2 + i * 0.6, 0.5, 0.65));
        ctx.effects.shockRing({ x: lx, y: 0, z: lz }, 0xffb040, 0.6, 6.5, 0.7, 1.2, 0.8);
        ctx.effects.groundDust(lx, lz, 4.6, 22);
        ctx.effects.burst({ x: hx, y: hy, z: hz }, 0xffc868, 30, 7.5, 0.6, 0.13);
        ctx.effects.flash(at, 1.0, 0xffa83c, 1.2, 4.5, 0.25, 0.7, 1.6);
        ctx.effects.addShake(0.17 * ctx.nearness(at, 18));
      });
    }
  },

  onFrame(ctx, snap, dt) {
    const now = ctx.time;
    // Scheduled (delayed) beats.
    for (let i = pending.length - 1; i >= 0; i--) {
      if (now >= pending[i].at) {
        const run = pending[i].run;
        pending.splice(i, 1);
        run();
      }
    }
    if (pool !== null) pool.update(ctx.camera, dt);

    for (let id = 0; id < slots.length; id++) {
      const s = slots[id];
      if (s === undefined || s.targetId < 0) continue;
      const f = snap.fighters[id];
      if (f === undefined) continue;
      const stage = f.ultStage ?? 0;
      ctx.fighterPos(id, _a);
      ctx.fighterPos(s.targetId, _b);
      if (s.reticle !== null) {
        if (!s.reticle.held(id)) s.reticle = null;
        else if (stage >= H.stage.pin) {
          s.reticle.hide(0.25);
          s.reticle = null;
        } else {
          s.reticle.update(_b.x, 0, _b.z, 1.6);
          const p = Math.min(1, (now - s.t0) / s.lead);
          if (stage >= H.stage.leap) {
            if (s.reticle.style !== 'committed') s.reticle.setStyle('committed');
            s.reticle.setCommit(1);
          } else s.reticle.setCommit(p * 0.9);
        }
      }
      if (s.arc !== null) {
        if (!s.arc.held(id)) s.arc = null;
        else if (stage >= H.stage.pin) {
          s.arc.hide(0.2);
          s.arc = null;
        } else {
          // From where the lion took off (fixed) to the victim: the pounce path.
          s.arc.update(stage >= H.stage.leap ? s.startX : _a.x, 0.9, stage >= H.stage.leap ? s.startZ : _a.z, _b.x, 0.9, _b.z, 2.6);
        }
      }
      // Coil dust at the lion's paws; a dust trail while it flies.
      if (f.ultPhase === 'windup' && now >= s.nextDust) {
        s.nextDust = now + 0.09;
        dust(ctx, _a.x, 0.1, _a.z, 1, 0.3);
      } else if (stage === H.stage.leap && f.ultPhase === 'active' && now >= s.nextDust) {
        s.nextDust = now + 0.04;
        ctx.effects.puff(_a.x, _a.y + 0.4, _a.z, 0, 0.2, 0, 0.45, 0.4, 1.0, 0.85, 0.72, 0.5, 0.35, -0.2, 2);
        ctx.effects.spark(_a.x, _a.y + 0.5, _a.z, 0, 0.3, 0, 0.3, 0.14, 0.02, 1, 0.75, 0.3, 0.8, 0, 3);
      }
    }
    updateMarks(ctx, snap, dt);
  },

  onEnd(_ctx, fighterId) {
    const s = slots[fighterId];
    if (s !== undefined) {
      s.targetId = -1;
      s.reticle = null;
      s.arc = null;
    }
  },

  dispose() {
    slots.length = 0;
    pending.length = 0;
    for (const m of marks) {
      if (m === undefined) continue;
      if (m.ring !== null && m.ring.active) m.ring.hide(0);
      if (m.aura !== null) m.aura.parent?.remove(m.aura);
      if (m.glyph !== null) m.glyph.parent?.remove(m.glyph);
      if (m.glyphMat !== null) m.glyphMat.dispose();
    }
    marks.length = 0;
    for (const mat of _auraMats) mat.dispose();
    _auraMats.length = 0;
    if (auraGeo !== null) auraGeo.dispose();
    if (glyphGeo !== null) glyphGeo.dispose();
    auraGeo = null;
    glyphGeo = null;
    if (pool !== null) pool.dispose();
    pool = null;
    disposeClawTexture();
  },
};

export default lionFx;
