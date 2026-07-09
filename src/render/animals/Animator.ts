/**
 * Animation core for the animal rigs (BLUEPRINT §5.1 / §11.3).
 *
 * - {@link Joint}: a named pivot with a captured rest pose plus per-frame target
 *   channels (euler rotation, position offset, uniform scale). Targets are
 *   blended toward with a 0.1 s cross-fade whenever the fighter's action
 *   changes, giving smooth transitions with zero per-frame allocation.
 * - {@link BaseRig}: the shared skeleton driver every animal extends. It derives
 *   ALL action animation purely from `FighterState` (action + actionT/actionDur
 *   + vel + buffs + grab/burrow/glide fields). The only internal clocks are the
 *   ambient phases (idle breathing, gait) and the post-death fade timer, which
 *   §5.1 / §11.3 explicitly allow.
 * - Attack swings peak EXACTLY at u = 0.55 of the swing (§7.3 impact instant)
 *   via {@link attackCurve} / {@link impactPulse}.
 */

import * as THREE from 'three';
import type { AnimalId, BuffState, FighterAction, FighterState } from '../../core/types';
import { ANIMALS, type AnimalDef } from '../../config/animals';
import { makePalette, type Palette, makeMat, mesh, coneGeo, sphGeo } from './parts';

/** Render contract for one fighter's visual body (BLUEPRINT §5.1, verbatim). */
export interface AnimalRig {
  root: THREE.Group;
  update(state: FighterState, dtRender: number): void;
  accent: number;
}

// ── Easing / curve helpers ───────────────────────────────────────────────────

/** The binding impact fraction of a swing (§7.3): the strike lands at 55%. */
export const IMPACT = 0.55;

export function easeInCubic(t: number): number {
  return t * t * t;
}

export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Hermite smoothstep on [0,1]. */
export function smooth01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Normalized sub-phase: 0 before `a`, 1 after `b`, linear ramp between. */
export function ramp(u: number, a: number, b: number): number {
  const t = (u - a) / (b - a);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Quartic bump centred on `c` with half-width `w` (0 outside, 1 at centre). */
export function bell(u: number, c: number, w: number): number {
  const d = (u - c) / w;
  if (d <= -1 || d >= 1) return 0;
  const q = 1 - d * d;
  return q * q;
}

/**
 * Signed basic-swing profile over u = actionT/actionDur:
 * windup to −0.45 by u=0.32, accelerates into the strike reaching exactly +1.0
 * at u = 0.55 (the §7.3 impact instant), then recovers to 0 by u=1.
 */
export function attackCurve(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  if (u < 0.32) return -0.45 * easeOutCubic(u / 0.32);
  if (u < IMPACT) return -0.45 + 1.45 * easeInCubic((u - 0.32) / (IMPACT - 0.32));
  return 1 - smooth01((u - IMPACT) / (1 - IMPACT));
}

/**
 * Unsigned pulse that rises just before the impact instant, peaks exactly at
 * u = 0.55, and decays after — for jaw snaps / ground slams.
 */
export function impactPulse(u: number, w = 0.1): number {
  if (u < IMPACT) {
    const a = IMPACT - w;
    return u <= a ? 0 : easeInCubic((u - a) / w);
  }
  const d = (u - IMPACT) / (w * 2.2);
  return d >= 1 ? 0 : 1 - smooth01(d);
}

/** Allocation-free buff lookup. */
export function hasBuff(state: FighterState, kind: BuffState['kind']): boolean {
  const buffs = state.buffs;
  for (let i = 0; i < buffs.length; i++) {
    if (buffs[i].kind === kind) return true;
  }
  return false;
}

// ── Joint ────────────────────────────────────────────────────────────────────

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * One articulated pivot. Captures its REST transform at construction (so
 * register a joint only after the node's build-time position/rotation is
 * final). Pose code writes the additive channels each frame; `apply()` blends
 * from the snapshot taken at the last action change toward the target.
 */
export class Joint {
  readonly node: THREE.Object3D;
  private readonly restPos: THREE.Vector3;
  private readonly restQuat: THREE.Quaternion;
  private readonly snapPos: THREE.Vector3;
  private readonly snapQuat: THREE.Quaternion;
  private snapS = 1;

  /** Target rotation (radians, applied in the joint's rest frame, XYZ order). */
  rx = 0;
  ry = 0;
  rz = 0;
  /** Target position offset from the rest position (metres, local space). */
  px = 0;
  py = 0;
  pz = 0;
  /** Target uniform scale. */
  s = 1;

  constructor(node: THREE.Object3D) {
    this.node = node;
    this.restPos = node.position.clone();
    this.restQuat = node.quaternion.clone();
    this.snapPos = node.position.clone();
    this.snapQuat = node.quaternion.clone();
    this.snapS = node.scale.x;
  }

  reset(): void {
    this.rx = this.ry = this.rz = 0;
    this.px = this.py = this.pz = 0;
    this.s = 1;
  }

  /** Capture the currently-rendered transform as the cross-fade source. */
  snapshot(): void {
    this.snapPos.copy(this.node.position);
    this.snapQuat.copy(this.node.quaternion);
    this.snapS = this.node.scale.x;
  }

  /** Write the blended transform into the node. `f` = eased fade 0..1. */
  apply(f: number): void {
    _e.set(this.rx, this.ry, this.rz, 'XYZ');
    _q.setFromEuler(_e);
    _q2.copy(this.restQuat).multiply(_q);
    _v.set(this.restPos.x + this.px, this.restPos.y + this.py, this.restPos.z + this.pz);
    if (f >= 1) {
      this.node.quaternion.copy(_q2);
      this.node.position.copy(_v);
      this.node.scale.setScalar(this.s);
    } else {
      this.node.quaternion.slerpQuaternions(this.snapQuat, _q2, f);
      this.node.position.lerpVectors(this.snapPos, _v, f);
      this.node.scale.setScalar(this.snapS + (this.s - this.snapS) * f);
    }
  }
}

// ── BaseRig ──────────────────────────────────────────────────────────────────

const FADE_DUR = 0.1; // §11.3: 0.1 s cross-fade between actions
const DEATH_FADE_START = 3.0; // §11.3: fade after 3 s ...
const DEATH_FADE_DUR = 1.5; // ... over this long ...
const DEATH_OPACITY = 0.4; // ... to 40% opacity
const STEALTH_OPACITY = 0.22; // §7.7: stealth ⇒ ~85% transparent
const GAIT_OFF = [0, Math.PI, Math.PI, 0]; // diagonal quadruped pairs FL,FR,BL,BR

/**
 * Shared driver every animal rig extends. Subclass contract:
 *  - build the body under `this.bodyRoot` in the constructor,
 *  - assign `this.body` and `this.head` (and optionally `this.legs`/`this.tail`),
 *  - call `this.finalize()` last,
 *  - implement the abstract pose hooks (generic hit/stagger/knockdown/dead/…
 *    are provided and overridable).
 */
export abstract class BaseRig implements AnimalRig {
  readonly root = new THREE.Group();
  readonly accent: number;

  protected readonly def: AnimalDef;
  protected readonly pal: Palette;
  /** Everything visible; hidden while burrowed (the mound shows instead). */
  protected readonly bodyRoot = new THREE.Group();

  /** Core pivot at hip height — generic poses tilt/drop this. */
  protected body!: Joint;
  /** Head pivot — generic poses shake/recoil this. */
  protected head!: Joint;
  /** Leg pivots in FL, FR, BL, BR order (may be empty / shorter). */
  protected legs: Joint[] = [];
  /** Optional tail base. */
  protected tail: Joint | null = null;

  /** How far the body pivot drops when collapsing (≈ hip height − body radius). */
  protected hipDrop = 0.45;
  /** Gait frequency in stride cycles per metre travelled (freq ∝ speed). */
  protected strideRate = 0.33;
  /** Which side the body falls toward on knockdown/death (±1). */
  protected fallDir = 1;

  // Ambient phases (internal clocks are allowed for these only, §5.1).
  protected idlePhase = 0;
  protected gaitPhase = 0;
  protected timePhase = 0;
  protected deathT = 0;

  private readonly jointList: Joint[] = [];
  private readonly mats: THREE.MeshStandardMaterial[] = [];
  private readonly mound: THREE.Group;
  private prevAction: FighterAction = 'idle';
  private prevActionT = 0;
  private fadeT = FADE_DUR;
  private curOpacity = 1;

  protected constructor(def: AnimalDef) {
    this.def = def;
    this.pal = makePalette(def.accent);
    this.accent = this.pal.accent;
    this.root.add(this.bodyRoot);

    // Dirt mound shown while burrowed (§11.3). Cheap: two cones + a pebble.
    const soil = makeMat(0x5b432c);
    const soil2 = makeMat(0x6e5438);
    this.mound = new THREE.Group();
    const r = Math.max(0.5, def.radius * 1.15);
    this.mound.add(mesh(coneGeo(r, r * 0.55, 8), soil, 0, r * 0.27, 0));
    this.mound.add(mesh(coneGeo(r * 0.55, r * 0.5, 6), soil2, r * 0.4, r * 0.22, r * 0.3));
    this.mound.add(mesh(sphGeo(r * 0.18, 5, 4), soil2, -r * 0.45, r * 0.12, -r * 0.2));
    this.mound.visible = false;
    this.root.add(this.mound);
  }

  /** Register a pivot as an animated joint (AFTER its rest transform is final). */
  protected joint(node: THREE.Object3D): Joint {
    const j = new Joint(node);
    this.jointList.push(j);
    return j;
  }

  /** Collect materials for opacity control. Call once at the end of the ctor. */
  protected finalize(): void {
    this.bodyRoot.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) {
        if (!this.mats.includes(o.material)) this.mats.push(o.material);
      }
    });
  }

  /** Free all geometries/materials owned by this rig. */
  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material;
        if (Array.isArray(m)) for (const mm of m) mm.dispose();
        else m.dispose();
      }
    });
  }

  // ── The per-frame drive (BLUEPRINT §5.1: all from state) ──────────────────

  update(state: FighterState, dtRender: number): void {
    const dt = dtRender < 0 ? 0 : dtRender > 0.1 ? 0.1 : dtRender;
    const speed = Math.hypot(state.vel.x, state.vel.z);

    // Ambient phases. Gait frequency is proportional to horizontal speed.
    this.timePhase += dt;
    this.idlePhase += dt * 1.7;
    this.gaitPhase += dt * speed * this.strideRate * Math.PI * 2;

    // Action-change detection (also re-trigger when the same action restarts).
    if (state.action !== this.prevAction || state.actionT + 0.05 < this.prevActionT) {
      for (let i = 0; i < this.jointList.length; i++) this.jointList[i].snapshot();
      this.fadeT = 0;
      if (state.action === 'dead') this.deathT = 0;
      this.prevAction = state.action;
    }
    this.prevActionT = state.actionT;
    this.fadeT += dt;
    if (state.action === 'dead') this.deathT += dt;

    // Burrowed: hide the body, show the churning dirt mound.
    const burrowed = state.action === 'burrowed';
    this.bodyRoot.visible = !burrowed;
    this.mound.visible = burrowed;
    if (burrowed) {
      const w = 1 + 0.07 * Math.sin(this.timePhase * 15);
      this.mound.scale.set(w, 2 - w, w);
      this.mound.rotation.y = Math.sin(this.timePhase * 7) * 0.2;
    } else {
      // Pose targets reset, then the action writes its pose, then we blend.
      for (let i = 0; i < this.jointList.length; i++) this.jointList[i].reset();
      const u = state.actionDur > 1e-6 ? Math.min(1, state.actionT / state.actionDur) : 0;
      this.pose(state, u, speed);
      const f = this.fadeT >= FADE_DUR ? 1 : smooth01(this.fadeT / FADE_DUR);
      for (let i = 0; i < this.jointList.length; i++) this.jointList[i].apply(f);
    }

    // Opacity: stealth buff (§7.7) and the post-death fade (§11.3).
    let target = 1;
    if (hasBuff(state, 'stealth')) target = STEALTH_OPACITY;
    if (state.action === 'dead' && this.deathT > DEATH_FADE_START) {
      const k = Math.min(1, (this.deathT - DEATH_FADE_START) / DEATH_FADE_DUR);
      const dead = 1 - (1 - DEATH_OPACITY) * k;
      if (dead < target) target = dead;
    }
    this.curOpacity += (target - this.curOpacity) * Math.min(1, dt * 8);
    if (Math.abs(this.curOpacity - target) < 0.004) this.curOpacity = target;
    this.applyOpacity(this.curOpacity);
  }

  private lastApplied = 1;
  private applyOpacity(o: number): void {
    if (Math.abs(o - this.lastApplied) < 0.003) return;
    this.lastApplied = o;
    const transparent = o < 0.995;
    for (let i = 0; i < this.mats.length; i++) {
      const m = this.mats[i];
      m.opacity = o;
      m.transparent = transparent;
    }
  }

  // ── Action dispatch ────────────────────────────────────────────────────────

  private pose(state: FighterState, u: number, speed: number): void {
    switch (state.action) {
      case 'idle':
        this.poseIdle(this.idlePhase);
        break;
      case 'run':
        if (speed > 0.08) this.poseRun(speed);
        else this.poseIdle(this.idlePhase);
        break;
      case 'attack1':
        this.poseAttack(1, u);
        break;
      case 'attack2':
        this.poseAttack(2, u);
        break;
      case 'attack3':
        this.poseAttack(3, u);
        break;
      case 'special':
        this.poseSpecial(u, state);
        break;
      case 'ultimate':
        this.poseUltimate(u, state);
        break;
      case 'block':
        this.poseBlock(this.timePhase);
        break;
      case 'hit':
        this.poseHit(u);
        break;
      case 'stagger':
        this.poseStagger(u);
        break;
      case 'knockdown':
        this.poseKnockdown(u);
        break;
      case 'feared':
        this.poseFeared(speed);
        break;
      case 'jump':
        this.poseJump(state);
        break;
      case 'glide':
        this.poseGlide(state);
        break;
      case 'grab':
        this.poseGrab(u, state);
        break;
      case 'grabbed':
        this.poseGrabbed(this.timePhase);
        break;
      case 'dead':
        this.poseDead();
        break;
      case 'burrowed':
        break; // body hidden; mound handled in update()
    }
  }

  // ── Abstract per-animal hooks ─────────────────────────────────────────────

  protected abstract poseIdle(t: number): void;
  protected abstract poseRun(speed: number): void;
  protected abstract poseAttack(n: 1 | 2 | 3, u: number): void;
  protected abstract poseSpecial(u: number, state: FighterState): void;
  protected abstract poseUltimate(u: number, state: FighterState): void;
  protected abstract poseBlock(t: number): void;

  // ── Generic poses (overridable) ───────────────────────────────────────────

  /** Quadruped gait: diagonal leg pairs + body bob. Amp scales with speed. */
  protected quadGait(speed: number, amp = 0.65, bob = 0.045): void {
    const k = Math.min(1, speed / this.def.speed);
    const p = this.gaitPhase;
    const n = Math.min(this.legs.length, 4);
    for (let i = 0; i < n; i++) {
      this.legs[i].rx = Math.sin(p + GAIT_OFF[i]) * amp * k;
    }
    this.body.py = Math.sin(p * 2) * bob * k;
    this.body.rx = Math.sin(p * 2 + 1.2) * 0.035 * k;
  }

  protected poseHit(u: number): void {
    const k = 1 - easeOutCubic(u);
    this.body.rx = -0.18 * k;
    this.body.py = -0.05 * k;
    this.head.rx = -0.3 * k;
    this.head.ry = 0.15 * k;
  }

  protected poseStagger(u: number): void {
    const w = 1 - easeInCubic(u);
    this.body.rz = Math.sin(u * 18) * 0.2 * w;
    this.body.rx = -0.12 * w;
    this.body.py = -0.08 * w;
    this.head.rz = Math.sin(u * 18 + 1.1) * 0.28 * w;
    for (let i = 0; i < this.legs.length; i++) this.legs[i].rx = Math.sin(u * 18 + i * 2) * 0.12 * w;
  }

  /** §7.7 knockdown: fast fall, hold down, rise over the final ~30%. */
  protected poseKnockdown(u: number): void {
    const fall = easeInCubic(ramp(u, 0, 0.16));
    const rise = smooth01(ramp(u, 0.72, 1));
    const k = fall * (1 - rise);
    this.body.rz = this.fallDir * 1.35 * k;
    this.body.py = -this.hipDrop * k;
    this.head.rz = this.fallDir * 0.3 * k;
    for (let i = 0; i < this.legs.length; i++) this.legs[i].rx = 0.4 * k;
  }

  /** Collapse to the side with a settle bounce; the fade is handled centrally. */
  protected poseDead(): void {
    const t = this.deathT;
    const k = easeOutCubic(Math.min(1, t / 0.5));
    const wob = Math.sin(Math.min(t, 1.2) * 9) * Math.max(0, 1 - t / 1.2) * 0.05;
    this.body.rz = this.fallDir * (1.5 * k + wob);
    this.body.py = -this.hipDrop * k;
    this.head.rz = this.fallDir * 0.25 * k;
    this.head.rx = 0.2 * k;
    for (let i = 0; i < this.legs.length; i++) this.legs[i].rx = (0.35 + 0.12 * (i % 2)) * k;
  }

  /** Panicked flee: full-speed gait plus frantic head shake (§7.7 fear). */
  protected poseFeared(speed: number): void {
    this.poseRun(Math.max(speed, this.def.speed));
    this.head.ry = Math.sin(this.timePhase * 13) * 0.32;
    this.head.rx = -0.15;
    this.body.py += -0.03;
  }

  protected poseJump(state: FighterState): void {
    const up = state.vel.y > 0;
    this.body.rx = up ? -0.13 : 0.1;
    for (let i = 0; i < this.legs.length; i++) this.legs[i].rx = i < 2 ? 0.55 : -0.45;
  }

  protected poseGlide(state: FighterState): void {
    this.poseJump(state);
  }

  /** Holding a grabbed victim: freeze the finisher impact pose + struggle. */
  protected poseGrab(_u: number, _state: FighterState): void {
    this.poseAttack(3, IMPACT);
    this.head.ry += Math.sin(this.timePhase * 9) * 0.08;
  }

  /** Held by an attacker: hoisted, limp, shaken. */
  protected poseGrabbed(t: number): void {
    this.body.py = 0.22;
    this.body.rz = Math.sin(t * 12) * 0.09;
    this.body.rx = 0.12;
    this.head.rx = 0.3;
    for (let i = 0; i < this.legs.length; i++) this.legs[i].rx = 0.5 + Math.sin(t * 12 + i) * 0.1;
  }
}

/** Fresh mutable FighterState for previews/demos (idle, full HP, at origin). */
export function makeMockState(animal: AnimalId): FighterState {
  const def = ANIMALS[animal];
  return {
    id: 0,
    animal,
    isPlayer: false,
    alive: true,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    hp: def.hp,
    maxHp: def.hp,
    guard: def.guardMax,
    maxGuard: def.guardMax,
    guardRegenDelay: 0,
    ultCharge: 0,
    specialCd: 0,
    action: 'idle',
    actionT: 0,
    actionDur: 0,
    comboIndex: 0,
    comboWindow: 0,
    buffs: [],
    kills: 0,
    damageDealt: 0,
    damageBlocked: 0,
    ultsUsed: 0,
    grabTargetId: -1,
    grabbedById: -1,
    airborne: false,
    glideT: 0,
    burrowT: 0,
  };
}
