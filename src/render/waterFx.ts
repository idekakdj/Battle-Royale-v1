/**
 * Water FX (v1.8 jungle, WP-J3): the splash / ripple / wake effects of the shallow pool.
 *
 * Owned by {@link Effects} (it lazily creates one `WaterFx`; the rigs reach it through the `FxSink.splash` / `FxSink.wake`
 * hooks and the match reaches it through `Effects.handleSplashEvent`). Everything is pooled and bounded:
 *
 *  - {@link RippleField}: ONE InstancedBufferGeometry draw call, {@link RIPPLE_CAPACITY} expanding rings animated entirely on
 *    the GPU from a shared time uniform (per-instance centre / birth / life / radius / width / alpha). Splash rings, the V-shaped
 *    wake trail behind a moving swimmer and footstep ripples all go through it.
 *  - droplets / spray: spawned into Effects' existing soft particle pool (so no new draw call, no new allocation).
 *  - {@link waterContacts}: a small uniform array (one slot per recently-reported swimmer) the jungle water shader reads to draw
 *    a bright waterline halo + ripple around each swimmer's legs (the "rim where the water meets the animals").
 *
 * Tier scaling: droplet counts follow `tierProfile().fxScale`; on `low` the secondary rings are skipped.
 * Node-safe to import (no DOM at import time); constructing needs only three's geometry/material classes.
 */

import * as THREE from 'three';
import type { GameEventOf } from '../core/types';
import { TAU, clamp01 } from '../core/math';
import { tierProfile } from './quality';
import { getRenderArena, waterActivity, waterSurfaceAt, WATER_ACTIVITY_MAX } from './arenaContext';

/** Concurrent ripple rings (one InstancedBufferGeometry draw call). */
export const RIPPLE_CAPACITY = 56;
/** Swimmers the water shader draws a contact halo for. */
export const WATER_CONTACT_SLOTS = 12;
/** Max droplets one splash may spawn (before the tier scale). */
export const SPLASH_MAX_DROPLETS = 42;

/**
 * Contact halos read by the jungle water shader: `(x, z, radius, strength 0..1)` per slot. Module-level so the water mesh and the
 * FX share them with no wiring (one match renders at a time, like `fxBus`). Strength 0 = unused slot.
 */
export const waterContacts: THREE.Vector4[] = Array.from({ length: WATER_CONTACT_SLOTS }, () => new THREE.Vector4(0, 0, 0, 0));

/** The particle spawners WaterFx borrows from Effects (soft = normal blend, glow = additive). */
export interface WaterParticles {
  puff(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    ttl: number, size0: number, size1: number,
    r: number, g: number, b: number,
    alpha?: number, gravity?: number, damping?: number,
  ): void;
  spark(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    ttl: number, size0: number, size1: number,
    r: number, g: number, b: number,
    alpha?: number, gravity?: number, damping?: number,
  ): void;
}

// ── Ripple rings (GPU animated) ──────────────────────────────────────────────

const RIPPLE_VERTEX = /* glsl */ `
attribute vec4 aRing;   // x, z, birth, life
attribute vec4 aParam;  // maxRadius, width (fraction of maxRadius), alpha, y
uniform float uTime;
varying vec2 vLocal;
varying float vAge;
varying vec2 vParam;
void main() {
  float age = (uTime - aRing.z) / max(aRing.w, 0.001);
  vAge = age;
  vParam = vec2(aParam.y, aParam.z);
  vLocal = position.xz;
  float R = aParam.x * 1.2;
  float live = step(age, 1.0) * step(0.0, age);
  vec3 p = vec3(aRing.x + position.x * R * live, aParam.w, aRing.y + position.z * R * live);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const RIPPLE_FRAGMENT = /* glsl */ `
varying vec2 vLocal;
varying float vAge;
varying vec2 vParam;
void main() {
  if (vAge < 0.0 || vAge > 1.0) discard;
  float d = length(vLocal) * 1.2;                  // 0..1 of maxRadius
  float ringR = 1.0 - pow(1.0 - vAge, 2.4);        // ease-out expansion
  float w = max(vParam.x, 0.02) * (0.6 + 0.8 * vAge);
  float ring = 1.0 - smoothstep(0.0, w, abs(d - ringR));
  float inner = smoothstep(0.0, ringR, d) * (1.0 - smoothstep(ringR - w * 2.5, ringR, d)); // faint trailing wash
  float a = (ring + inner * 0.12) * pow(1.0 - vAge, 1.35) * vParam.y;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(0.55, 0.8, 0.76), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Pool of expanding water rings: one draw call, GPU animated. */
export class RippleField {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.InstancedBufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  private readonly aRing: THREE.InstancedBufferAttribute;
  private readonly aParam: THREE.InstancedBufferAttribute;
  private readonly timeU = { value: 0 };
  private cursor = 0;
  private dirty = false;
  /** Rings spawned since construction (tests / stats). */
  spawned = 0;

  constructor() {
    const plane = new THREE.PlaneGeometry(2, 2);
    plane.rotateX(-Math.PI / 2);
    this.geo.index = plane.index;
    this.geo.setAttribute('position', plane.getAttribute('position'));
    this.geo.setAttribute('uv', plane.getAttribute('uv'));
    const ring = new Float32Array(RIPPLE_CAPACITY * 4);
    for (let i = 0; i < RIPPLE_CAPACITY; i++) {
      ring[i * 4 + 2] = -1000; // dead
      ring[i * 4 + 3] = 1;
    }
    this.aRing = new THREE.InstancedBufferAttribute(ring, 4);
    this.aParam = new THREE.InstancedBufferAttribute(new Float32Array(RIPPLE_CAPACITY * 4), 4);
    this.aRing.setUsage(THREE.DynamicDrawUsage);
    this.aParam.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aRing', this.aRing);
    this.geo.setAttribute('aParam', this.aParam);
    this.geo.instanceCount = RIPPLE_CAPACITY;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.timeU },
      vertexShader: RIPPLE_VERTEX,
      fragmentShader: RIPPLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4; // after the water surface (renderOrder 3), before sprite FX
  }

  get time(): number {
    return this.timeU.value;
  }

  /** Spawn one ring: centre, max radius (m), life (s), alpha, width (fraction of radius), surface y. */
  spawn(x: number, z: number, maxR: number, life: number, alpha: number, width: number, y: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % RIPPLE_CAPACITY;
    this.aRing.setXYZW(i, x, z, this.timeU.value, Math.max(0.05, life));
    this.aParam.setXYZW(i, maxR, width, alpha, y + 0.02);
    this.dirty = true;
    this.spawned++;
  }

  /** Advance the clock and upload any new rings. */
  update(dt: number): void {
    this.timeU.value += dt;
    if (this.dirty) {
      this.aRing.needsUpdate = true;
      this.aParam.needsUpdate = true;
      this.dirty = false;
    }
  }

  /** Number of rings still alive (CPU-side count, for tests). */
  liveCount(): number {
    let n = 0;
    const t = this.timeU.value;
    for (let i = 0; i < RIPPLE_CAPACITY; i++) {
      const age = (t - this.aRing.getZ(i)) / Math.max(0.001, this.aRing.getW(i));
      if (age >= 0 && age <= 1) n++;
    }
    return n;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ── WaterFx ──────────────────────────────────────────────────────────────────

interface WakeState {
  next: number;
}

interface ContactSlot {
  src: THREE.Object3D | null;
  seen: number;
  radius: number;
}

const CONTACT_HOLD = 0.18; // s a halo stays at full strength after the last report
const CONTACT_FADE = 0.25; // s to fade out after that

export class WaterFx {
  readonly ripples = new RippleField();
  private time = 0;
  private readonly wakes = new WeakMap<THREE.Object3D, WakeState>();
  private readonly slots: ContactSlot[] = Array.from({ length: WATER_CONTACT_SLOTS }, () => ({ src: null, seen: -10, radius: 0 }));
  private activityN = 0;
  /** Droplet counts spawned by the last splash (tests). */
  lastDroplets = 0;

  constructor(private readonly particles: WaterParticles) {}

  get root(): THREE.Object3D {
    return this.ripples.mesh;
  }

  /**
   * A splash at (x, z): pooled droplet burst + expanding rings sized by `radius` (m) and `strength` (0..1).
   * Used for entry/exit events, a swimming animal's attack impact and heavy strokes.
   */
  splash(x: number, z: number, radius: number, strength: number): void {
    const s = clamp01(strength);
    const r = Math.min(4, Math.max(0.25, radius));
    const y = waterSurfaceAt(x, z);
    const prof = tierProfile();
    const fx = prof.fxScale;

    // Rings: a big shock ring, a tight inner one, and (strong splashes, non-low tiers) a slow outer swell.
    this.ripples.spawn(x, z, r * (1.5 + 1.7 * s), 0.8 + 0.7 * s, 0.38 + 0.3 * s, 0.08, y);
    this.ripples.spawn(x, z, r * (0.7 + 0.6 * s), 0.55 + 0.2 * s, 0.3 + 0.25 * s, 0.1, y);
    if (s > 0.35 && prof.fxScale > 0.7) this.ripples.spawn(x, z, r * (3.2 + 2.2 * s), 1.4 + 0.6 * s, 0.16 + 0.2 * s, 0.06, y);

    // Droplets: radial fan + a crown at the radius, all landing back on the surface.
    const n = Math.min(SPLASH_MAX_DROPLETS, Math.max(3, Math.round((6 + 30 * s) * Math.sqrt(r) * fx)));
    this.lastDroplets = n;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TAU;
      const crown = i % 3 === 0;
      const rad = crown ? r * (0.5 + Math.random() * 0.4) : Math.random() * r * 0.4;
      const sp = (0.5 + Math.random() * 1.5) * (0.45 + 0.9 * s) * (crown ? 1.1 : 0.7);
      const vy = 2.0 + Math.random() * (2.6 + 4.2 * s);
      const ttl = Math.max(0.2, (2 * vy) / 14) * 0.92;
      const size = (0.07 + Math.random() * 0.07) * (0.8 + 0.6 * s);
      const sh = 0.82 + Math.random() * 0.18;
      this.particles.puff(
        x + Math.cos(ang) * rad, y + 0.05, z + Math.sin(ang) * rad,
        Math.cos(ang) * sp, vy, Math.sin(ang) * sp,
        ttl, size, size * 0.55,
        0.72 * sh, 0.92 * sh, 1.0 * sh, 0.85, -14, 0.5,
      );
    }
    // A soft mist plume for big hits.
    if (s > 0.4) {
      const m = Math.max(2, Math.round(3 * fx));
      for (let i = 0; i < m; i++) {
        const ang = Math.random() * TAU;
        this.particles.puff(
          x + Math.cos(ang) * r * 0.3, y + 0.15, z + Math.sin(ang) * r * 0.3,
          Math.cos(ang) * 0.6, 0.6 + Math.random() * 0.8, Math.sin(ang) * 0.6,
          0.55 + Math.random() * 0.3, 0.3 + 0.2 * r, 0.9 + 0.5 * r,
          0.85, 0.96, 1.0, 0.2 + 0.12 * s, -0.2, 2.2,
        );
      }
    }
    // A bright glint on the strongest splashes (additive, tiny).
    if (s > 0.6) {
      this.particles.spark(x, y + 0.2, z, 0, 1.2, 0, 0.18, 0.35 * r, 0.1, 0.55, 0.75, 0.8, 0.5, 0, 3);
    }
    waterActivity.stamp = performance.now();
  }

  /**
   * A swimmer moves: refresh its contact halo (follows the rig every frame) and — throttled per source — drop a V-shaped ring
   * trail behind it. `speed` m/s, `scale` ≈ body size.
   */
  wake(source: THREE.Object3D, x: number, z: number, speed: number, scale: number): void {
    const sc = Math.min(3, Math.max(0.3, scale));
    this.touchContact(source, sc * 0.6);
    this.noteActivity(x, z, speed);
    if (speed < 0.35) return;
    let st = this.wakes.get(source);
    if (st === undefined) {
      st = { next: 0 };
      this.wakes.set(source, st);
    }
    if (this.time < st.next) return;
    const interval = Math.min(0.34, Math.max(0.12, 0.36 - speed * 0.035));
    st.next = this.time + interval * (0.85 + Math.random() * 0.3);

    const y = waterSurfaceAt(x, z);
    const yaw = source.rotation.y;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const k = Math.min(1, speed / 6);
    const bx = x - fx * 0.55 * sc;
    const bz = z - fz * 0.55 * sc;
    const px = fz; // perpendicular (right)
    const pz = -fx;
    const a = 0.26 + 0.2 * k;
    this.ripples.spawn(bx, bz, sc * (0.9 + 0.5 * k), 0.95, a, 0.12, y);
    if (tierProfile().fxScale > 0.7) {
      const arm = 0.5 * sc;
      this.ripples.spawn(bx + px * arm, bz + pz * arm - fz * 0.2 * sc, sc * (0.55 + 0.3 * k), 0.8, a * 0.8, 0.14, y);
      this.ripples.spawn(bx - px * arm, bz - pz * arm - fz * 0.2 * sc, sc * (0.55 + 0.3 * k), 0.8, a * 0.8, 0.14, y);
    }
    if (speed > 2.5 && Math.random() < 0.6) {
      const ang = Math.random() * TAU;
      this.particles.puff(
        x + Math.cos(ang) * 0.3 * sc, y + 0.05, z + Math.sin(ang) * 0.3 * sc,
        Math.cos(ang) * 0.5, 1.6 + Math.random() * 1.2, Math.sin(ang) * 0.5,
        0.35, 0.07, 0.04, 0.75, 0.94, 1.0, 0.8, -14, 0.5,
      );
    }
  }

  /** A footstep that lands in the water: a small ring + two droplets. */
  step(x: number, z: number, scale: number): void {
    const y = waterSurfaceAt(x, z);
    this.ripples.spawn(x, z, 0.5 + 0.7 * Math.min(1.5, scale), 0.7, 0.3, 0.13, y);
    for (let i = 0; i < 2; i++) {
      const ang = Math.random() * TAU;
      this.particles.puff(
        x + Math.cos(ang) * 0.15, y + 0.05, z + Math.sin(ang) * 0.15,
        Math.cos(ang) * 0.5, 1.4 + Math.random(), Math.sin(ang) * 0.5,
        0.3, 0.06, 0.03, 0.74, 0.93, 1.0, 0.75, -14, 0.4,
      );
    }
  }

  /** The `splash` GameEvent (entering / leaving the pool): droplets + rings scaled by `strength`. */
  handleSplashEvent(e: GameEventOf<'splash'>): void {
    const s = clamp01(e.strength);
    this.splash(e.pos.x, e.pos.z, 0.6 + 1.2 * s, e.entering ? s : s * 0.7);
  }

  /** Advance the ripple clock, contact halos and the audio activity board. */
  update(dt: number): void {
    this.time += dt;
    this.ripples.update(dt);
    // Contact halos: follow the source rig; fade a moment after the last report.
    for (let i = 0; i < this.slots.length; i++) {
      const sl = this.slots[i];
      const v = waterContacts[i];
      if (sl.src === null) {
        v.w = 0;
        continue;
      }
      const idle = this.time - sl.seen;
      if (idle > CONTACT_HOLD + CONTACT_FADE || sl.src.parent === null) {
        sl.src = null;
        v.w = 0;
        continue;
      }
      v.x = sl.src.position.x;
      v.y = sl.src.position.z;
      v.z = sl.radius;
      v.w = idle <= CONTACT_HOLD ? 1 : 1 - (idle - CONTACT_HOLD) / CONTACT_FADE;
    }
    // Publish the activity board for the audio (positions are refreshed each wake call; stale entries expire there).
    waterActivity.count = this.activityN;
    this.activityN = 0;
  }

  /** Drop every ring / halo (arena change, rematch). */
  clear(): void {
    for (const v of waterContacts) v.w = 0;
    for (const s of this.slots) s.src = null;
    waterActivity.count = 0;
  }

  dispose(): void {
    this.clear();
    this.ripples.dispose();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private touchContact(source: THREE.Object3D, radius: number): void {
    let slot = -1;
    let oldest = 0;
    let oldestSeen = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      const sl = this.slots[i];
      if (sl.src === source) {
        slot = i;
        break;
      }
      if (sl.src === null && slot < 0) slot = i;
      if (sl.seen < oldestSeen) {
        oldestSeen = sl.seen;
        oldest = i;
      }
    }
    if (slot < 0) slot = oldest;
    const sl = this.slots[slot];
    sl.src = source;
    sl.seen = this.time;
    sl.radius = radius;
    const v = waterContacts[slot];
    v.x = source.position.x;
    v.y = source.position.z;
    v.z = radius;
    v.w = 1;
  }

  private noteActivity(x: number, z: number, speed: number): void {
    const i = this.activityN;
    if (i >= WATER_ACTIVITY_MAX) return;
    waterActivity.x[i] = x;
    waterActivity.z[i] = z;
    waterActivity.speed[i] = speed;
    this.activityN = i + 1;
    waterActivity.stamp = performance.now();
  }

  /** True when the current arena has a pool (nothing to do otherwise). */
  static arenaHasWater(): boolean {
    return getRenderArena().terrain.some((z) => z.kind === 'water');
  }
}
