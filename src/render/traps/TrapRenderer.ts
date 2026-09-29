/**
 * TrapRenderer (v1.2 WP-P) — draws the arena traps from `snapshot.traps`.
 *
 * Phases (from {@link TrapState}):
 *  - armed:    a pressure plate flush with the sand. Fire = dark basalt disc
 *              with an ember-orange rune ring; spikes = iron plate with a hex
 *              grid of dark holes that smoulder red. Slow, subtle pulse.
 *  - active:   fire = flame tongues (HDR, bloom-friendly) + white-hot vents,
 *              rising embers and (high tier only) one pooled flickering heat
 *              light; spikes = instanced iron cones thrust up out of the holes.
 *              A red-orange danger ring marks the radius for the whole window.
 *              Last {@link WARN_SECONDS}: the ring blinks faster and faster,
 *              flames sputter / spikes tremble and sink — "get out now".
 *  - cooldown: flames die / spikes retract; a soot (fire) or churned-sand
 *              (spikes) decal stays until the plate re-arms, when the glow
 *              returns with a short flash.
 *
 * One-shot bursts (flame burst, metallic flash, dust rings, smoke) go through
 * the shared {@link Effects} particle pools via {@link TrapFxSink}, so traps
 * never exceed the global particle budget.
 *
 * Budget: ≤ {@link MAX_TRAPS} traps, everything instanced — 4 draw calls with
 * only armed plates (fire plates, spike plates, scorch, glow overlay), up to 7
 * while hazards are up (+ flames, embers, spikes; + spikes in the shadow pass
 * on medium/high). No per-frame allocations: state lives in preallocated slots
 * and typed arrays; layout is rebuilt only when the trap set changes.
 */

import * as THREE from 'three';
import type { GameEventOf, TrapKind, TrapPhase, TrapState, Vec3 } from '../../core/types';
import { TAU, clamp01, mulberry32 } from '../../core/math';
import { getQualityTier, type QualityTier } from '../quality';
import { SPIKE_HOLES, makeTrapTextures, type TrapTextures } from './trapTextures';
import {
  DISC_VERTEX,
  EMBER_FRAGMENT,
  EMBER_VERTEX,
  FLAME_FRAGMENT,
  FLAME_VERTEX,
  OVERLAY_FRAGMENT,
  SCORCH_FRAGMENT,
} from './trapShaders';

export const MAX_TRAPS = 8;
/** Render-side fallback for the active window (the sim's `timeLeft` wins). */
export const TRAP_ACTIVE_SECONDS = 8;
/** Final seconds of the active window that visibly warn the hazard is ending. */
export const WARN_SECONDS = 1.5;

const FLAME_DIE = 0.6;
const EMBER_TAIL = 1.6;
const SPIKE_RETRACT = 0.35;
const REARM_FLASH = 0.8;
const REARM_GLOW_LEAD = 1.0; // s before re-arm the plate glow starts returning
const SCORCH_RISE = 0.7;
const SCORCH_FADE = 1.2; // s before re-arm the decal fades out
const SPIKE_HEIGHT = 0.95;
const SPIKE_BASE_R = 0.085;
const EMBERS_MAX = 20;
const FLAMES_MAX = 16;
const LIGHT_BASE = 26;
const NEAR_RANGE = 9; // m — trigger bursts shake the camera inside this range

const FLAMES_BY_TIER: Record<QualityTier, readonly [number, number]> = {
  // [inner ring, outer ring] around one centre plume
  low: [4, 5],
  medium: [5, 7],
  high: [6, 9],
};
const EMBERS_BY_TIER: Record<QualityTier, number> = { low: 7, medium: 13, high: 20 };

/** Anything that can spawn the one-shot trap bursts (the live Effects). */
export interface TrapFxSink {
  onTrapTrigger(kind: TrapKind, pos: Vec3, radius: number, nearness: number): void;
  onTrapExpire(kind: TrapKind, pos: Vec3, radius: number): void;
}

interface Slot {
  id: number;
  kind: TrapKind;
  x: number;
  z: number;
  radius: number;
  phase: TrapPhase;
  timeLeft: number;
  sinceTrigger: number;
  sinceExpire: number;
  sinceArm: number;
  /** Hazard intensity: fire = flame strength, spikes = extension (0..~1.1). */
  intensity: number;
  lastIntensity: number;
  danger: number;
  lastDanger: number;
  heat: number;
  armedGlow: number;
  scorch: number;
  seed: number;
}

function makeSlot(): Slot {
  return {
    id: -1,
    kind: 'fire',
    x: 0,
    z: 0,
    radius: 1,
    phase: 'armed',
    timeLeft: 0,
    sinceTrigger: 99,
    sinceExpire: 99,
    sinceArm: 99,
    intensity: 0,
    lastIntensity: 0,
    danger: 0,
    lastDanger: 0,
    heat: 0,
    armedGlow: 1,
    scorch: 0,
    seed: 0,
  };
}

function smooth01(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/** Flame layout per tier: (nx, nz, scale, phase) per flame, centre first. */
function flameLayout(tier: QualityTier): Float32Array {
  const [inner, outer] = FLAMES_BY_TIER[tier];
  const out = new Float32Array((1 + inner + outer) * 4);
  let o = 0;
  const put = (x: number, z: number, s: number, ph: number): void => {
    out[o++] = x;
    out[o++] = z;
    out[o++] = s;
    out[o++] = ph;
  };
  put(0, 0, 2.1, 0.13);
  for (let i = 0; i < inner; i++) {
    const a = (i / inner) * TAU + 0.4;
    put(Math.cos(a) * 0.38, Math.sin(a) * 0.38, 1.5, 0.618 * (i + 1));
  }
  for (let i = 0; i < outer; i++) {
    const a = (i / outer) * TAU + 0.9;
    put(Math.cos(a) * 0.74, Math.sin(a) * 0.74, 1.02, 0.37 * (i + 3));
  }
  return out;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _e = new THREE.Euler();

export class TrapRenderer {
  readonly group = new THREE.Group();

  private readonly scene: THREE.Scene;
  private readonly fx: TrapFxSink | null;
  private readonly textures: TrapTextures;

  private readonly slots: Slot[] = [];
  private slotCount = 0;
  private clock = 0;
  private focusX = 0;
  private focusZ = 0;
  private hasFocus = false;
  private tier: QualityTier;
  private readonly layouts: Record<QualityTier, Float32Array>;
  private readonly burstPos: Vec3 = { x: 0, y: 0, z: 0 };

  // Plates.
  private readonly plateGeo: THREE.BufferGeometry;
  private readonly firePlateMat: THREE.MeshStandardMaterial;
  private readonly spikePlateMat: THREE.MeshStandardMaterial;
  private readonly firePlates: THREE.InstancedMesh;
  private readonly spikePlates: THREE.InstancedMesh;

  // Decals (scorch + glow overlay share the per-trap aT attribute).
  private readonly aT: THREE.InstancedBufferAttribute;
  private readonly aScorch: THREE.InstancedBufferAttribute;
  private readonly aOverlay: THREE.InstancedBufferAttribute;
  private readonly scorchGeo: THREE.InstancedBufferGeometry;
  private readonly overlayGeo: THREE.InstancedBufferGeometry;
  private readonly scorchMat: THREE.ShaderMaterial;
  private readonly overlayMat: THREE.ShaderMaterial;
  private readonly timeU = { value: 0 };

  // Flames.
  private readonly flameGeo: THREE.InstancedBufferGeometry;
  private readonly flameMat: THREE.ShaderMaterial;
  private readonly flames: THREE.Mesh;
  private readonly aFlame: THREE.InstancedBufferAttribute;
  private readonly aInfo: THREE.InstancedBufferAttribute;
  private flameCount = 0;

  // Embers.
  private readonly emberGeo: THREE.BufferGeometry;
  private readonly emberMat: THREE.ShaderMaterial;
  private readonly embers: THREE.Points;
  private readonly aAmp: THREE.BufferAttribute;
  private readonly emberScale = { value: 600 };
  private embersLive = false;

  // Spikes.
  private readonly spikeGeo: THREE.BufferGeometry;
  private readonly spikeMat: THREE.MeshStandardMaterial;
  private readonly spikes: THREE.InstancedMesh;
  private readonly spikeQuat: Float32Array;
  private readonly spikeScale: Float32Array;
  private spikeCount = 0;

  // Heat light (high tier only; always present there so toggling never
  // changes the light count → no shader recompiles mid-fight).
  private readonly light: THREE.PointLight;

  constructor(scene: THREE.Scene, fx: TrapFxSink | null = null) {
    this.scene = scene;
    this.fx = fx;
    this.textures = makeTrapTextures();
    this.tier = getQualityTier();
    this.layouts = { low: flameLayout('low'), medium: flameLayout('medium'), high: flameLayout('high') };
    for (let i = 0; i < MAX_TRAPS; i++) this.slots.push(makeSlot());

    // ── Plates ──────────────────────────────────────────────────────────────
    this.plateGeo = new THREE.CircleGeometry(1, 56).rotateX(-Math.PI / 2);
    const plateMat = (map: THREE.Texture, rough: number, metal: number): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({
        map,
        roughness: rough,
        metalness: metal,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      });
    this.firePlateMat = plateMat(this.textures.firePlate, 0.92, 0.05);
    this.spikePlateMat = plateMat(this.textures.spikePlate, 0.55, 0.45);
    this.firePlates = new THREE.InstancedMesh(this.plateGeo, this.firePlateMat, MAX_TRAPS);
    this.spikePlates = new THREE.InstancedMesh(this.plateGeo, this.spikePlateMat, MAX_TRAPS);
    for (const p of [this.firePlates, this.spikePlates]) {
      p.count = 0;
      p.receiveShadow = true;
      p.castShadow = false;
      p.frustumCulled = false;
      p.visible = false;
      this.group.add(p);
    }

    // ── Scorch + overlay decals ─────────────────────────────────────────────
    const quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.aT = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TRAPS * 4), 4);
    this.aScorch = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TRAPS * 4), 4);
    this.aOverlay = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TRAPS * 4), 4);
    this.aScorch.setUsage(THREE.DynamicDrawUsage);
    this.aOverlay.setUsage(THREE.DynamicDrawUsage);
    const decalGeo = (aS: THREE.InstancedBufferAttribute): THREE.InstancedBufferGeometry => {
      const g = new THREE.InstancedBufferGeometry();
      g.index = quad.index;
      g.setAttribute('position', quad.getAttribute('position'));
      g.setAttribute('aT', this.aT);
      g.setAttribute('aS', aS);
      g.instanceCount = 0;
      return g;
    };
    this.scorchGeo = decalGeo(this.aScorch);
    this.overlayGeo = decalGeo(this.aOverlay);
    this.scorchMat = new THREE.ShaderMaterial({
      uniforms: { uExtent: { value: 1.42 }, uLift: { value: 0.016 } },
      vertexShader: DISC_VERTEX,
      fragmentShader: SCORCH_FRAGMENT,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      fog: false,
    });
    this.overlayMat = new THREE.ShaderMaterial({
      uniforms: {
        uExtent: { value: 1.3 },
        uLift: { value: 0.024 },
        uMask: { value: this.textures.glowMask },
        uTime: this.timeU,
      },
      vertexShader: DISC_VERTEX,
      fragmentShader: OVERLAY_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
      fog: false,
    });
    const scorch = new THREE.Mesh(this.scorchGeo, this.scorchMat);
    scorch.frustumCulled = false;
    scorch.renderOrder = 2;
    const overlay = new THREE.Mesh(this.overlayGeo, this.overlayMat);
    overlay.frustumCulled = false;
    overlay.renderOrder = 3;
    this.group.add(scorch, overlay);

    // ── Flames ──────────────────────────────────────────────────────────────
    const fq = new THREE.PlaneGeometry(1, 1);
    this.flameGeo = new THREE.InstancedBufferGeometry();
    this.flameGeo.index = fq.index;
    this.flameGeo.setAttribute('position', fq.getAttribute('position'));
    this.flameGeo.setAttribute('uv', fq.getAttribute('uv'));
    this.aFlame = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TRAPS * FLAMES_MAX * 4), 4);
    this.aInfo = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TRAPS * FLAMES_MAX * 2), 2);
    this.aFlame.setUsage(THREE.DynamicDrawUsage);
    this.aInfo.setUsage(THREE.DynamicDrawUsage);
    this.flameGeo.setAttribute('aFlame', this.aFlame);
    this.flameGeo.setAttribute('aInfo', this.aInfo);
    this.flameGeo.instanceCount = 0;
    this.flameMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.timeU },
      vertexShader: FLAME_VERTEX,
      fragmentShader: FLAME_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.flames = new THREE.Mesh(this.flameGeo, this.flameMat);
    this.flames.frustumCulled = false;
    this.flames.renderOrder = 4;
    this.flames.visible = false;
    this.group.add(this.flames);

    // ── Embers ──────────────────────────────────────────────────────────────
    const ne = MAX_TRAPS * EMBERS_MAX;
    this.emberGeo = new THREE.BufferGeometry();
    this.emberGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ne * 3), 3));
    this.emberGeo.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(ne * 4), 4));
    this.aAmp = new THREE.BufferAttribute(new Float32Array(ne), 1);
    this.aAmp.setUsage(THREE.DynamicDrawUsage);
    this.emberGeo.setAttribute('aAmp', this.aAmp);
    this.emberMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.timeU, uScale: this.emberScale },
      vertexShader: EMBER_VERTEX,
      fragmentShader: EMBER_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.embers = new THREE.Points(this.emberGeo, this.emberMat);
    this.embers.frustumCulled = false;
    this.embers.renderOrder = 5;
    this.embers.visible = false;
    this.group.add(this.embers);

    // ── Spikes ──────────────────────────────────────────────────────────────
    this.spikeGeo = new THREE.ConeGeometry(SPIKE_BASE_R, SPIKE_HEIGHT, 6, 1, true).translate(0, SPIKE_HEIGHT / 2, 0);
    this.spikeMat = new THREE.MeshStandardMaterial({
      color: 0x6f747c,
      metalness: 0.7,
      roughness: 0.34,
      flatShading: true,
      emissive: 0x120d0a,
    });
    const nh = SPIKE_HOLES.length;
    this.spikes = new THREE.InstancedMesh(this.spikeGeo, this.spikeMat, MAX_TRAPS * nh);
    this.spikes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.spikes.count = 0;
    this.spikes.frustumCulled = false;
    this.spikes.visible = false;
    this.spikes.castShadow = this.tier !== 'low';
    this.group.add(this.spikes);
    // Per-hole tilt + height variety (deterministic).
    this.spikeQuat = new Float32Array(nh * 4);
    this.spikeScale = new Float32Array(nh);
    const rnd = mulberry32(0x5c1e);
    for (let i = 0; i < nh; i++) {
      _e.set((rnd() - 0.5) * 0.16, rnd() * TAU, (rnd() - 0.5) * 0.16);
      _q.setFromEuler(_e);
      this.spikeQuat[i * 4] = _q.x;
      this.spikeQuat[i * 4 + 1] = _q.y;
      this.spikeQuat[i * 4 + 2] = _q.z;
      this.spikeQuat[i * 4 + 3] = _q.w;
      // Centre spikes stand a touch taller.
      const h = SPIKE_HOLES[i];
      this.spikeScale[i] = 0.82 + rnd() * 0.3 + (1 - Math.hypot(h.x, h.z) / 0.8) * 0.12;
    }

    // ── Heat light ──────────────────────────────────────────────────────────
    this.light = new THREE.PointLight(0xff7a30, 0, 7.5, 2);
    this.light.castShadow = false;
    this.light.visible = this.tier === 'high';
    this.group.add(this.light);

    scene.add(this.group);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Point the camera cares about (player / spectated fighter) — scales burst shake. */
  setFocus(x: number, z: number): void {
    this.focusX = x;
    this.focusZ = z;
    this.hasFocus = true;
  }

  /** `trapTriggered` → start the hazard at once (the snapshot confirms it next frame). */
  onTriggered(e: GameEventOf<'trapTriggered'>): void {
    const s = this.find(e.trapId);
    if (s !== null && s.phase !== 'active') this.beginActive(s);
  }

  /** `trapExpired` → flames die / spikes retract. */
  onExpired(e: GameEventOf<'trapExpired'>): void {
    const s = this.find(e.trapId);
    if (s !== null && s.phase === 'active') this.endActive(s);
  }

  /**
   * 0..1 loudness for a "fire crackle" bed at (x, z): the strongest burning
   * fire trap, falling off over ~16 m past its rim.
   */
  fireProximity(x: number, z: number): number {
    let best = 0;
    for (let i = 0; i < this.slotCount; i++) {
      const s = this.slots[i];
      if (s.kind !== 'fire' || s.intensity <= 0.01) continue;
      const d = Math.hypot(s.x - x, s.z - z) - s.radius;
      const k = clamp01(1 - Math.max(0, d) / 16);
      const v = Math.min(1, s.intensity) * k * k;
      if (v > best) best = v;
    }
    return best;
  }

  /** Live counts for demos / perf reports. */
  stats(): { traps: number; flames: number; spikes: number; embers: boolean; light: boolean } {
    return {
      traps: this.slotCount,
      flames: this.flameCount,
      spikes: this.spikeCount,
      embers: this.embersLive,
      light: this.light.visible && this.light.intensity > 0,
    };
  }

  /** Mirror the snapshot's traps; call once per rendered frame. */
  update(traps: readonly TrapState[], dt: number): void {
    this.clock += dt;
    this.timeU.value = this.clock;
    this.emberScale.value = (window.innerHeight * Math.min(2, window.devicePixelRatio || 1)) / 1.04;

    const tier = getQualityTier();
    if (tier !== this.tier) {
      this.tier = tier;
      this.light.visible = tier === 'high';
      this.spikes.castShadow = tier !== 'low';
    }

    if (this.layoutChanged(traps)) this.rebuild(traps);

    for (let i = 0; i < this.slotCount; i++) {
      const s = this.slots[i];
      const t = traps[i];
      if (t.phase !== s.phase) {
        if (t.phase === 'active') this.beginActive(s);
        else if (s.phase === 'active') this.endActive(s);
        if (t.phase === 'armed') s.sinceArm = 0;
        s.phase = t.phase;
      }
      s.timeLeft = t.timeLeft;
      this.evaluate(s, dt);
    }

    this.writeDecals();
    this.writeFlames();
    this.writeEmbers();
    this.writeSpikes();
    this.updateLight();
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.plateGeo.dispose();
    this.firePlateMat.dispose();
    this.spikePlateMat.dispose();
    this.firePlates.dispose();
    this.spikePlates.dispose();
    this.scorchGeo.dispose();
    this.overlayGeo.dispose();
    this.scorchMat.dispose();
    this.overlayMat.dispose();
    this.flameGeo.dispose();
    this.flameMat.dispose();
    this.emberGeo.dispose();
    this.emberMat.dispose();
    this.spikeGeo.dispose();
    this.spikeMat.dispose();
    this.spikes.dispose();
    this.light.dispose();
    this.textures.dispose();
  }

  // ── Layout ──────────────────────────────────────────────────────────────────

  private find(id: number): Slot | null {
    for (let i = 0; i < this.slotCount; i++) if (this.slots[i].id === id) return this.slots[i];
    return null;
  }

  private layoutChanged(traps: readonly TrapState[]): boolean {
    const n = Math.min(traps.length, MAX_TRAPS);
    if (n !== this.slotCount) return true;
    for (let i = 0; i < n; i++) {
      const s = this.slots[i];
      const t = traps[i];
      if (s.id !== t.id || s.kind !== t.kind) return true;
      if (Math.abs(s.x - t.pos.x) > 1e-3 || Math.abs(s.z - t.pos.z) > 1e-3 || Math.abs(s.radius - t.radius) > 1e-3) {
        return true;
      }
    }
    return false;
  }

  /** (Re)build plates, decal instances and ember seeds for a new trap set. */
  private rebuild(traps: readonly TrapState[]): void {
    const n = Math.min(traps.length, MAX_TRAPS);
    this.slotCount = n;
    let nf = 0;
    let ns = 0;
    const emberPos = this.emberGeo.getAttribute('position') as THREE.BufferAttribute;
    const emberSeed = this.emberGeo.getAttribute('aSeed') as THREE.BufferAttribute;
    for (let i = 0; i < n; i++) {
      const t = traps[i];
      const s = this.slots[i];
      s.id = t.id;
      s.kind = t.kind;
      s.x = t.pos.x;
      s.z = t.pos.z;
      s.radius = t.radius;
      s.phase = t.phase;
      s.timeLeft = t.timeLeft;
      s.sinceTrigger = 99;
      s.sinceExpire = 99;
      s.sinceArm = 99;
      s.seed = ((t.id * 0.6180339887) % 1 + 1) % 1;
      s.intensity = t.phase === 'active' ? 1 : 0;
      s.lastIntensity = s.intensity;
      s.danger = t.phase === 'active' ? 1 : 0;
      s.lastDanger = s.danger;
      s.heat = 0;
      s.armedGlow = t.phase === 'armed' ? 1 : 0;
      s.scorch = t.phase === 'armed' ? 0 : 1;

      _m.makeScale(t.radius, 1, t.radius).setPosition(t.pos.x, 0.006, t.pos.z);
      if (t.kind === 'fire') this.firePlates.setMatrixAt(nf++, _m);
      else this.spikePlates.setMatrixAt(ns++, _m);

      this.aT.setXYZW(i, t.pos.x, t.pos.z, t.radius, t.kind === 'fire' ? 1 : 0);

      const rnd = mulberry32(0xe3be ^ (t.id * 7919));
      for (let k = 0; k < EMBERS_MAX; k++) {
        const j = i * EMBERS_MAX + k;
        const a = rnd() * TAU;
        const r = Math.sqrt(rnd()) * t.radius * 0.8;
        emberPos.setXYZ(j, t.pos.x + Math.cos(a) * r, 0.15, t.pos.z + Math.sin(a) * r);
        emberSeed.setXYZW(j, Math.cos(a) * 0.4, Math.sin(a) * 0.4, rnd(), rnd());
      }
    }
    for (let j = n * EMBERS_MAX; j < MAX_TRAPS * EMBERS_MAX; j++) this.aAmp.setX(j, 0);
    emberPos.needsUpdate = true;
    emberSeed.needsUpdate = true;
    this.aAmp.needsUpdate = true;
    this.aT.needsUpdate = true;

    this.firePlates.count = nf;
    this.spikePlates.count = ns;
    this.firePlates.visible = nf > 0;
    this.spikePlates.visible = ns > 0;
    this.firePlates.instanceMatrix.needsUpdate = true;
    this.spikePlates.instanceMatrix.needsUpdate = true;
    this.scorchGeo.instanceCount = n;
    this.overlayGeo.instanceCount = n;
  }

  // ── Phase transitions ───────────────────────────────────────────────────────

  private nearness(s: Slot): number {
    if (!this.hasFocus) return 1;
    const d = Math.hypot(s.x - this.focusX, s.z - this.focusZ);
    return clamp01(1 - d / NEAR_RANGE);
  }

  private beginActive(s: Slot): void {
    s.phase = 'active';
    s.sinceTrigger = 0;
    s.timeLeft = TRAP_ACTIVE_SECONDS;
    if (this.fx !== null) {
      this.burstPos.x = s.x;
      this.burstPos.y = 0;
      this.burstPos.z = s.z;
      this.fx.onTrapTrigger(s.kind, this.burstPos, s.radius, this.nearness(s));
    }
  }

  private endActive(s: Slot): void {
    s.phase = 'cooldown';
    s.sinceExpire = 0;
    s.lastIntensity = s.intensity;
    s.lastDanger = s.danger;
    if (this.fx !== null) {
      this.burstPos.x = s.x;
      this.burstPos.y = 0;
      this.burstPos.z = s.z;
      this.fx.onTrapExpire(s.kind, this.burstPos, s.radius);
    }
  }

  /** Derive this frame's visual parameters from phase + timers. */
  private evaluate(s: Slot, dt: number): void {
    s.sinceTrigger += dt;
    s.sinceExpire += dt;
    s.sinceArm += dt;
    const fire = s.kind === 'fire';
    const time = this.clock;
    let scorchTarget = 0;

    if (s.phase === 'armed') {
      s.armedGlow = 1 + 1.6 * Math.max(0, 1 - s.sinceArm / REARM_FLASH);
      s.danger = 0;
      s.heat = 0;
      s.intensity = 0;
    } else if (s.phase === 'active') {
      const k = s.sinceTrigger;
      const rise = clamp01(k / 0.15);
      const u = s.timeLeft < WARN_SECONDS ? 1 - s.timeLeft / WARN_SECONDS : 0; // 0→1 in the warning window
      let blink = 1;
      if (u > 0) {
        // Accelerating blink: ~1.5 Hz → ~5 Hz.
        const phase = time * (9 + u * 22);
        blink = Math.sin(phase) > -0.2 ? 1 : 0.25;
      }
      s.danger = rise * blink;
      s.armedGlow = Math.max(0, 1 - k / 0.25) * 0.8;
      if (fire) {
        const burst = 1 + 0.5 * Math.exp(-k * 5);
        const sputter = u > 0 ? (0.45 + 0.55 * Math.abs(Math.sin(time * 17 + s.seed * 9))) * (1 - 0.7 * u) : 1;
        s.intensity = rise * burst * sputter;
        s.heat = Math.min(1, s.intensity);
      } else {
        let ext: number;
        if (k < 0.08) ext = (k / 0.08) * 1.12;
        else if (k < 0.26) ext = 1.12 - 0.12 * smooth01((k - 0.08) / 0.18);
        else ext = 1;
        s.intensity = ext * (1 - 0.14 * u);
        s.heat = 0;
      }
      scorchTarget = fire ? 1 : 0.85;
    } else {
      const k = s.sinceExpire;
      s.danger = s.lastDanger * Math.max(0, 1 - k / 0.3);
      if (fire) {
        const f = Math.max(0, 1 - k / FLAME_DIE);
        s.intensity = s.lastIntensity * f * f;
        s.heat = Math.min(1, s.lastIntensity) * Math.max(0, 1 - k / 2.5);
      } else {
        s.intensity = s.lastIntensity * (1 - smooth01(k / SPIKE_RETRACT));
        s.heat = 0;
      }
      s.armedGlow = clamp01(1 - s.timeLeft / REARM_GLOW_LEAD) * 0.85;
      const base = fire ? 1 : 0.85;
      scorchTarget = s.timeLeft < SCORCH_FADE ? base * (s.timeLeft / SCORCH_FADE) : base;
    }

    if (scorchTarget > s.scorch) s.scorch = Math.min(scorchTarget, s.scorch + dt / SCORCH_RISE);
    else s.scorch = Math.max(scorchTarget, s.scorch - dt / 0.35);
  }

  // ── Per-frame buffer writes (typed arrays only) ─────────────────────────────

  private writeDecals(): void {
    const n = this.slotCount;
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      const s = this.slots[i];
      this.aOverlay.setXYZW(i, s.armedGlow, s.danger, s.heat, s.seed);
      this.aScorch.setXYZW(i, s.scorch, s.heat, 0, s.seed);
    }
    this.aOverlay.needsUpdate = true;
    this.aScorch.needsUpdate = true;
  }

  private writeFlames(): void {
    const layout = this.layouts[this.tier];
    const per = layout.length / 4;
    const fl = this.aFlame.array as Float32Array;
    const info = this.aInfo.array as Float32Array;
    const time = this.clock;
    let c = 0;
    for (let i = 0; i < this.slotCount; i++) {
      const s = this.slots[i];
      if (s.kind !== 'fire' || s.intensity < 0.02) continue;
      const rs = s.radius / 2;
      const grow = Math.min(1.5, s.intensity);
      for (let k = 0; k < per; k++) {
        const o = k * 4;
        const ph = layout[o + 3] + s.seed * 5;
        const breathe = 0.86 + 0.14 * Math.sin(time * 3.1 + ph * 5.3);
        fl[c * 4] = s.x + layout[o] * s.radius;
        fl[c * 4 + 1] = 0.02;
        fl[c * 4 + 2] = s.z + layout[o + 1] * s.radius;
        fl[c * 4 + 3] = layout[o + 2] * rs * grow * breathe;
        info[c * 2] = ph;
        info[c * 2 + 1] = Math.min(1, s.intensity * 1.1);
        c++;
      }
    }
    if (c > 0 || this.flameCount > 0) {
      this.aFlame.needsUpdate = true;
      this.aInfo.needsUpdate = true;
    }
    this.flameCount = c;
    this.flameGeo.instanceCount = c;
    this.flames.visible = c > 0;
  }

  private writeEmbers(): void {
    const amp = this.aAmp.array as Float32Array;
    const count = EMBERS_BY_TIER[this.tier];
    let any = false;
    for (let i = 0; i < this.slotCount; i++) {
      const s = this.slots[i];
      let a = 0;
      if (s.kind === 'fire') {
        if (s.phase === 'active') a = 0.45 + 0.55 * Math.min(1, s.intensity);
        else if (s.phase === 'cooldown') a = Math.min(1, s.lastIntensity) * Math.max(0, 1 - s.sinceExpire / EMBER_TAIL);
      }
      if (a > 0.004) any = true;
      const base = i * EMBERS_MAX;
      for (let k = 0; k < EMBERS_MAX; k++) amp[base + k] = k < count ? a : 0;
    }
    if (any || this.embersLive) this.aAmp.needsUpdate = true;
    this.embersLive = any;
    this.embers.visible = any;
  }

  private writeSpikes(): void {
    const nh = SPIKE_HOLES.length;
    const stride = this.tier === 'low' ? 2 : 1;
    const time = this.clock;
    let c = 0;
    for (let i = 0; i < this.slotCount; i++) {
      const s = this.slots[i];
      if (s.kind !== 'spikes' || s.intensity < 0.005) continue;
      const u = s.phase === 'active' && s.timeLeft < WARN_SECONDS ? 1 - s.timeLeft / WARN_SECONDS : 0;
      for (let h = 0; h < nh; h += stride) {
        const hole = SPIKE_HOLES[h];
        const hs = this.spikeScale[h];
        const tall = SPIKE_HEIGHT * hs;
        const tremble = u > 0 ? Math.sin(time * 46 + h * 1.7) * 0.025 * u : 0;
        const y = (s.intensity - 1) * tall + tremble;
        if (y + tall < 0.02) continue;
        _pos.set(s.x + hole.x * s.radius, y, s.z + hole.z * s.radius);
        _q.set(this.spikeQuat[h * 4], this.spikeQuat[h * 4 + 1], this.spikeQuat[h * 4 + 2], this.spikeQuat[h * 4 + 3]);
        _scl.set(1, hs, 1);
        _m.compose(_pos, _q, _scl);
        this.spikes.setMatrixAt(c++, _m);
      }
    }
    if (c > 0 || this.spikeCount > 0) this.spikes.instanceMatrix.needsUpdate = true;
    this.spikeCount = c;
    this.spikes.count = c;
    this.spikes.visible = c > 0;
  }

  private updateLight(): void {
    if (!this.light.visible) return;
    let best: Slot | null = null;
    let bestScore = 0;
    for (let i = 0; i < this.slotCount; i++) {
      const s = this.slots[i];
      if (s.kind !== 'fire' || s.intensity < 0.02) continue;
      const d2 = this.hasFocus ? (s.x - this.focusX) ** 2 + (s.z - this.focusZ) ** 2 : 0;
      const score = Math.min(1.5, s.intensity) / (1 + d2 / 150);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (best === null) {
      this.light.intensity = 0;
      return;
    }
    const t = this.clock;
    const flick = 0.82 + 0.12 * Math.sin(t * 13 + best.seed * 7) + 0.08 * Math.sin(t * 29.3);
    this.light.position.set(best.x, 1.3, best.z);
    this.light.intensity = LIGHT_BASE * Math.min(1.4, best.intensity) * flick * (best.radius / 2);
  }
}
