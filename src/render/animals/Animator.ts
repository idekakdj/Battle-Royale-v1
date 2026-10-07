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
 *
 * v1.3 WP-Q — FIRST PERSON for the local player's own rig: `setFirstPerson`
 * hides the profile's head/neck/mane/… by filtering the baked skinned meshes'
 * index buffers by bone (a hidden-part shadow proxy keeps the full silhouette
 * casting its shadow), `sampleFpEye` reports the eye for the CameraRig, and
 * the profile's FP-only pose hook runs after the shared pose and is blended by
 * an eased FP weight. All new members are prefixed `fpx` so subclass fields
 * (e.g. the eagle's `fp`) can never collide.
 */

import * as THREE from 'three';
import type { AnimalId, BuffState, FighterAction, FighterState } from '../../core/types';
import { ANIMALS, type AnimalDef } from '../../config/animals';
import { makePalette, type Palette, makeMat, mesh, coneGeo, sphGeo, mixColor } from './parts';
import { bakeRig } from './bake';
import { getQualityVersion, tierProfile } from '../quality';
import { getFxSink, type SlamKind } from '../fxBus';
import { waterSpeedMultiplier } from '../../config/terrain';
import {
  SWIM_BLEND_AIR_S,
  SWIM_BOB_W,
  SWIM_BLEND_S,
  SWIM_EYE_FRACTION,
  SWIM_IMPACT_U,
  SWIM_TUNE,
  WAKE_PERIOD_S,
  attackWarp,
  followBump,
  poolSinkScale,
  swimSplash,
  type SwimTune,
} from './swim';
import type { FpClip, FpEyeSample, FpLimb, FpPoseCtx, FpProfile } from './fp/types';
import { clampLength3, eyeWorldOffset, runBob, runSway } from './fp/math';
import { FpClipControl } from './fp/clip';
import { ultClock } from './fp/ultCam';

/** A ground-impact moment inside an action (fires the slam decal / dust ring). */
export interface SlamSpec {
  action: FighterAction;
  /** Action progress u at which it fires (e.g. IMPACT). */
  at: number;
  radius: number;
  kind: SlamKind;
  /** Metres in front of the fighter where the impact lands. */
  forward: number;
}

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
// First-person scratch (WP-Q).
const _fpv = new THREE.Vector3();
const _fpd = { x: 0, y: 0, z: 0 };
const _fpo = { x: 0, y: 0, z: 0 };
const _ar = new THREE.Vector3();
const _af = new THREE.Vector3();
const _au = new THREE.Vector3();
const _ap = new THREE.Vector3();
const _ad = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _pp = new THREE.Vector3();
const _ps = new THREE.Vector3();
const _am = new THREE.Matrix4();
const _pm = new THREE.Matrix4();
const _aq = new THREE.Quaternion();
const _pq = new THREE.Quaternion();

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

  /**
   * Champions League (src/brawl/render/pose): {@link apply} with a rotation-rate safety net. The change of the node's
   * rotation relative to its CURRENT value (= what was applied last frame) is capped at `cap` radians; position and
   * scale are unaffected. The Battle Royale path never calls this.
   */
  applyBrawl(f: number, cap: number): void {
    _e.set(this.rx, this.ry, this.rz, 'XYZ');
    _q.setFromEuler(_e);
    _q2.copy(this.restQuat).multiply(_q);
    _v.set(this.restPos.x + this.px, this.restPos.y + this.py, this.restPos.z + this.pz);
    if (f < 1) {
      _q.slerpQuaternions(this.snapQuat, _q2, f);
      _q2.copy(_q);
    }
    if (cap > 0) {
      const cur = this.node.quaternion;
      const d = Math.min(1, Math.abs(cur.x * _q2.x + cur.y * _q2.y + cur.z * _q2.z + cur.w * _q2.w));
      const ang = 2 * Math.acos(d);
      if (ang > cap) {
        _q.slerpQuaternions(cur, _q2, cap / ang);
        _q2.copy(_q);
      }
    }
    this.node.quaternion.copy(_q2);
    if (f >= 1) {
      this.node.position.copy(_v);
      this.node.scale.setScalar(this.s);
    } else {
      this.node.position.lerpVectors(this.snapPos, _v, f);
      this.node.scale.setScalar(this.snapS + (this.s - this.snapS) * f);
    }
  }
}

// ── BaseRig ──────────────────────────────────────────────────────────────────

/** Director eye slide (m) above which the own rig is not drawn at all (first person, ult-only clip animals). */
const SLIDE_HIDE = 0.45;
const FADE_DUR = 0.1; // §11.3: 0.1 s cross-fade between actions
const DEATH_FADE_START = 3.0; // §11.3: fade after 3 s ...
const DEATH_FADE_DUR = 1.5; // ... over this long ...
const DEATH_OPACITY = 0.4; // ... to 40% opacity
const STEALTH_OPACITY = 0.22; // §7.7: stealth ⇒ ~85% transparent
const GAIT_OFF = [0, Math.PI, Math.PI, 0]; // diagonal quadruped pairs FL,FR,BL,BR
/** Swimming: idle-bob angular rate (period 1.6 s) and the paddle-phase wrap (a multiple of 2π, keeps sin(ph·2), sin(ph·½) exact). */
// (SWIM_BOB_W lives in swim.ts)
const SWIM_PHASE_WRAP = Math.PI * 2 * 1000;

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

  /** Countershading strengths used by the bake (darker back / lighter belly). */
  protected toneBack = 0.2;
  protected toneBelly = 0.28;
  /** Outline thickness multiplier (bigger animals → slightly thicker). */
  protected outlineScale = 1;
  /** Footstep dust size (0 = no footsteps, e.g. the python). */
  protected stepScale = 0.7;
  /** Ground-impact moments (slam decals) — per animal. */
  protected slams: SlamSpec[] = [];

  /** Baked triangle count (budget check / demo readout). */
  triangleCount = 0;

  // ── Swimming (v1.8 WP-J4, see swim.ts) ───────────────────────────────────
  /** This animal's swim tuning (data in swim.ts); the per-animal `poseSwim` overrides read it. */
  protected readonly swim: SwimTune;
  /** Paddle cycle phase (rad): advances with the swim cadence (treading minimum, faster with speed). */
  protected swimPhase = 0;
  /** Smoothed water-speed fraction 0..1 (speed / this animal's top speed in the water). */
  protected swimMv = 0;
  /** Linear 0..1 water blend (eased by `smooth01` where it is applied); 0 = the land rig, exactly. */
  private swimBlend = 0;
  private swimWakeT = 0;
  private swimSunk = false;
  private swimPre: Float64Array | null = null;
  /** Top speed (m/s) in the water: land speed × the animal's water multiplier. */
  private readonly swimTop: number;

  private readonly jointList: Joint[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly mound: THREE.Group;
  private outlineMesh: THREE.SkinnedMesh | null = null;
  private depthMesh: THREE.SkinnedMesh | null = null;
  private outlineWidth: { value: number } | null = null;
  private outlineOn = false;
  /** v1.3 FP ult: the first-person camera is INSIDE this rig (the inverted-hull outline would fill the view with black). */
  private outlineClip = false;
  private qualityVer = -1;
  private prevAction: FighterAction = 'idle';
  private prevActionT = 0;
  private prevU = 0;
  private lastStep = 0;
  private fadeT = FADE_DUR;
  private curOpacity = 1;

  // ── First person (WP-Q) ────────────────────────────────────────────────
  /** Meshes baked by `finalize()` (body + glow + outline hull) — hidden-part filtering targets. */
  private fpxBaked: THREE.SkinnedMesh[] = [];
  private fpxBodyMesh: THREE.SkinnedMesh | null = null;
  private fpxShadow: THREE.SkinnedMesh | null = null;
  /** Full index of a filtered mesh's original (non-indexed) draw = null; filtered = these. */
  private readonly fpxFiltered = new Map<THREE.BufferGeometry, THREE.BufferAttribute>();
  /** Screen-space clear-zone control for this rig's colour materials (fp/clip.ts). */
  private fpxClip: FpClipControl | null = null;
  private fpxNames: Map<string, Joint> | null = null;
  private fpxProfile: FpProfile | null = null;
  /** Profile whose pose hook is still blending (kept while the FP weight fades out). */
  private fpxPose: FpProfile | null = null;
  private fpxW = 0;
  private fpxPre: Float32Array | null = null;
  private fpxDummy: Joint | null = null;
  private fpxCtx: FpPoseCtx | null = null;
  private fpxTrack: Joint | null = null;
  private readonly fpxRest = new THREE.Vector3();
  private readonly fpxEyeCur = { forward: 0, up: 0, side: 0 };
  private fpxBobK = 0;
  /** Pinned limbs (viewmodel). Entries persist while fading out so pins ease in/out with the action. */
  private readonly fpxAnch: {
    j: Joint; x: number; y: number; z: number; down: number; out: number; roll: number; w: number;
    axis: number; req: boolean; wCur: number;
  }[] = [];
  private fpxDt = 0.016;
  private fpxGait = 0;
  private fpxIdleT = 0;
  /** Camera look-pitch (rad, + = up), written each frame by the MatchController. */
  fpxLook = 0;
  /** v1.3 FP ult: multiplier on the profile's head-follow (set each frame by the ultimate camera director; 1 = unchanged). */
  fpxFollowScale = 1;

  protected constructor(def: AnimalDef) {
    this.def = def;
    this.swim = SWIM_TUNE[def.id];
    this.swimTop = Math.max(0.5, def.speed * waterSpeedMultiplier(def));
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

  /**
   * Bake every part into one skinned mesh (+ glow + outline hull) and collect
   * materials for opacity control. Call once at the end of the ctor, after
   * all joints are registered.
   */
  protected finalize(): void {
    const nodes = new Set<THREE.Object3D>();
    for (const j of this.jointList) nodes.add(j.node);
    const res = bakeRig(this.bodyRoot, nodes, {
      back: this.toneBack,
      belly: this.toneBelly,
      outlineColor: mixColor(this.pal.darker, 0x140d08, 0.72),
    });
    for (const m of res.materials) this.mats.push(m);
    this.depthMesh = res.depth;
    this.outlineMesh = res.outline;
    this.outlineWidth = res.outlineWidth;
    this.triangleCount = res.triangles;
    this.fpxBodyMesh = res.body;
    this.fpxBaked = [res.body];
    if (res.glow !== null) this.fpxBaked.push(res.glow);
    if (res.outline !== null) this.fpxBaked.push(res.outline);
    // Own-rig colour materials (per rig): the first-person clear zone patches these, never another fighter's.
    const colorMats: THREE.Material[] = [...res.materials];
    if (res.outlineMaterial !== null) colorMats.push(res.outlineMaterial);
    // The depth-only twin (visible while the rig is translucent, e.g. the panther's stealth) must be clipped too, or it keeps
    // occluding the world inside the clear zone with an invisible body.
    colorMats.push(res.depth.material as THREE.Material);
    this.fpxClip = new FpClipControl(colorMats);
    this.fpxResolveNames();
    this.applyQuality();
  }

  // ── First person (WP-Q) ─────────────────────────────────────────────────────

  /** True while a first-person profile is active on this rig. */
  get fpxActive(): boolean {
    return this.fpxProfile !== null;
  }

  /**
   * Index every joint the subclass stored on itself by property name
   * (`head`, `jaw`, `wingLIn`, arrays as `legs.0`, …) and remember each joint's
   * rest position in root-local space. Runs once at the end of `finalize()`
   * (all subclass fields are assigned by then; nothing is posed yet).
   */
  private fpxResolveNames(): void {
    const names = new Map<string, Joint>();
    const self = this as unknown as Record<string, unknown>;
    this.root.updateMatrixWorld(true);
    for (const key of Object.keys(self)) {
      if (key.startsWith('fpx') || key === 'jointList') continue;
      const v = self[key];
      if (v instanceof Joint) names.set(key, v);
      else if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (v[i] instanceof Joint) names.set(`${key}.${i}`, v[i] as Joint);
        }
      }
    }
    this.fpxNames = names;
    this.fpxDummy = new Joint(new THREE.Object3D());
    // Rest position of the eye-tracking candidate (default: the head).
    const head = names.get('head');
    if (head !== undefined) {
      this.fpxRest.setFromMatrixPosition(head.node.matrixWorld);
      this.root.worldToLocal(this.fpxRest);
    }
  }

  /**
   * Switch this rig into / out of first person (the LOCAL player's own rig).
   * With a profile: applies the profile's eye, hide list and FP pose hook (the
   * hide can be deferred with `hideNow = false` and applied later through
   * {@link setFpHidden}, so the head is only removed once the camera is close).
   * With `null`: everything is restored (parts visible, pose hook fades out).
   */
  setFirstPerson(profile: FpProfile | null, hideNow = true): void {
    if (profile === this.fpxProfile) {
      if (profile !== null) this.setFpHidden(hideNow);
      return;
    }
    this.fpxFilter(false); // a different profile brings a different hide list
    this.fpxProfile = profile;
    if (profile === null) {
      this.fpxFilter(false);
      return;
    }
    if (this.fpxNames === null) this.fpxResolveNames();
    this.fpxPose = profile;
    this.fpxTrack = (this.fpxNames as Map<string, Joint>).get(profile.track ?? 'head') ?? this.head;
    this.fpxEyeCur.forward = profile.eye.forward;
    this.fpxEyeCur.up = profile.eye.up;
    this.fpxEyeCur.side = profile.eye.side;
    this.fpxEyeInit = false;
    this.fpxFilter(hideNow);
  }

  /** Show / hide the profile's hidden parts without touching the pose weight. */
  setFpHidden(hidden: boolean): void {
    if (this.fpxProfile === null) return;
    this.fpxFilter(hidden);
  }

  private fpxEyeInit = false;
  private fpxHiddenOn = false;
  /** True while the local fighter's action is `ultimate` (drives the profile's `ultClip`). */
  private fpxUlt = false;
  /** Materials of the hidden props with their saved write flags (restored when first person ends). */
  private fpxDepthOff = false;
  private lastTransparent = false;
  private fpxPropMats: { m: THREE.Material; c: boolean; d: boolean }[] = [];

  /** The screen-space clear zone that applies right now: `clip` always, `ultClip` during the own ultimate, none otherwise. */
  private fpxClipSync(): void {
    if (this.fpxClip === null) return;
    const prof = this.fpxProfile;
    let clip: FpClip | undefined;
    if (this.fpxHiddenOn && prof !== null) clip = prof.clip ?? (this.fpxUlt ? prof.ultClip : undefined);
    this.fpxClip.set(clip);
    // While a clear zone applies, the translucent body's depth-only twin is switched off as well: it would keep occluding the
    // world (victim, VFX) at the screen edges with an invisible body (the panther's stealth during its ultimate).
    this.fpxDepthOff = clip !== undefined;
    if (this.depthMesh !== null) this.depthMesh.visible = this.lastTransparent && !this.fpxDepthOff;
  }

  /** Stop drawing (colour + depth; the shadow caster keeps working) the named non-skinned props, or restore them. */
  private fpxHideProps(names: readonly string[] | undefined): void {
    for (const p of this.fpxPropMats) {
      p.m.colorWrite = p.c;
      p.m.depthWrite = p.d;
    }
    this.fpxPropMats.length = 0;
    if (names === undefined) return;
    for (const name of names) {
      const o = this.root.getObjectByName(name);
      if (o === undefined) continue;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) continue;
      const ms = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of ms) {
        this.fpxPropMats.push({ m, c: m.colorWrite, d: m.depthWrite });
        m.colorWrite = false;
        m.depthWrite = false;
      }
    }
  }

  /**
   * Build the triangle filter of the baked meshes for the profile's hide list (+ `ultHide` while the own ultimate runs).
   * Cheap (one pass over a few thousand vertices) and only run when first person hides parts or the ultimate starts / ends.
   */
  private fpxBuildIndex(prof: FpProfile): void {
    const body = this.fpxBodyMesh;
    if (body === null) return;
    // Bones to hide (name → bone index), with optional keep-front thresholds.
    const bones = body.skeleton.bones as THREE.Object3D[];
    const hide = new Map<number, number>();
    const names = this.fpxNames as Map<string, Joint>;
    const list = this.fpxUlt && prof.ultHide !== undefined ? [...prof.hide, ...prof.ultHide] : prof.hide;
    for (const name of list) {
      let bi = -1;
      if (name === '_root') bi = 0;
      else {
        const j = names.get(name);
        if (j !== undefined) bi = bones.indexOf(j.node);
      }
      if (bi < 0) continue;
      const kf = prof.keepFront !== undefined ? prof.keepFront[name] : undefined;
      hide.set(bi, kf === undefined ? Infinity : kf);
    }
    for (const mesh of this.fpxBaked) {
      const geo = mesh.geometry;
      let attr = this.fpxFiltered.get(geo);
      // Rebuild each time: the hide list is per profile (cheap, init-time-ish).
      const si = geo.getAttribute('skinIndex');
      const sw = geo.getAttribute('skinWeight');
      const pos = geo.getAttribute('position');
      const nv = pos.count;
      const idx = new Uint32Array(nv);
      let n = 0;
      let dropped = 0;
      for (let t = 0; t + 2 < nv; t += 3) {
        // A triangle is hidden when ANY of its vertices is influenced (weight > 0) by a hidden bone, so no fragment of a hidden
        // part (a triangle straddling the head / jaw / horn, an outline-hull sliver, a glow eye) can ever survive. A bone with a
        // `keepFront` threshold keeps the triangles whose centroid lies at or ahead of it (profiles that want a visible snout tip).
        let visible = true;
        for (let v = 0; v < 3 && visible; v++) {
          for (let k = 0; k < 4; k++) {
            if (sw.getComponent(t + v, k) <= 0) continue;
            const rule = hide.get(si.getComponent(t + v, k));
            if (rule === undefined) continue;
            if (rule === Infinity) {
              visible = false;
              break;
            }
            const z = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
            if (z < rule) {
              visible = false;
              break;
            }
          }
        }
        if (visible) {
          idx[n++] = t;
          idx[n++] = t + 1;
          idx[n++] = t + 2;
        } else dropped++;
      }
      if (dropped === 0) {
        if (attr !== undefined) geo.setIndex(null);
        continue;
      }
      attr = new THREE.Uint32BufferAttribute(idx.slice(0, n), 1);
      this.fpxFiltered.set(geo, attr);
      geo.setIndex(attr);
    }
  }

  /** Apply (`on`) or clear the triangle filter on the baked meshes for the active profile's hide list. */
  private fpxFilter(on: boolean): void {
    const prof = this.fpxProfile;
    const wantOn = on && prof !== null && prof.hide.length > 0;
    if (wantOn === this.fpxHiddenOn) return;
    this.fpxHiddenOn = wantOn;
    // The screen-space clear zone is on exactly while the profile's parts are hidden (camera at the eye); `ultClip` only
    // while the own ultimate runs. Patch the materials now (entering first person) so the ultimate itself never recompiles.
    if (wantOn && prof !== null && prof.ultClip !== undefined && this.fpxClip !== null) this.fpxClip.prepare();
    this.fpxClipSync();
    this.fpxHideProps(wantOn && prof !== null ? prof.hideProps : undefined);
    if (!wantOn || prof === null) {
      for (const [geo] of this.fpxFiltered) geo.setIndex(null);
      if (this.fpxShadow !== null) this.fpxShadow.visible = false;
      return;
    }
    const body = this.fpxBodyMesh;
    if (body === null) return;
    this.fpxBuildIndex(prof);
    // Shadow proxy: the full silhouette keeps casting (colour/depth writes off).
    if (this.fpxShadow === null) {
      const src = body.geometry;
      const g2 = new THREE.BufferGeometry();
      for (const key of Object.keys(src.attributes)) g2.setAttribute(key, src.getAttribute(key));
      const m = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
      const sh = new THREE.SkinnedMesh(g2, m);
      this.bodyRoot.add(sh);
      sh.updateWorldMatrix(true, false);
      sh.bind(body.skeleton, body.bindMatrix);
      sh.boundingSphere = body.boundingSphere;
      sh.boundingBox = body.boundingBox;
      sh.castShadow = true;
      sh.receiveShadow = false;
      sh.renderOrder = -3;
      this.fpxShadow = sh;
    }
    this.fpxShadow.visible = true;
  }

  /**
   * Fill the camera's eye sample: exact root position + the eye offset in the
   * rig's yaw frame (profile eye + action offset + a fraction of the head's
   * motion) + un-smoothed run bob/sway. Returns false when no profile is active.
   */
  sampleFpEye(out: FpEyeSample): boolean {
    const prof = this.fpxProfile ?? this.fpxPose;
    if (prof === null) return false;
    this.root.updateMatrixWorld(true);
    let dx = 0;
    let dy = 0;
    let dz = 0;
    const follow = (prof.follow ?? 0.6) * this.fpxFollowScale;
    const tr = this.fpxTrack;
    if (tr !== null && follow > 0) {
      _fpv.setFromMatrixPosition(tr.node.matrixWorld);
      this.root.worldToLocal(_fpv);
      _fpd.x = _fpv.x - this.fpxRest.x;
      _fpd.y = _fpv.y - this.fpxRest.y;
      _fpd.z = _fpv.z - this.fpxRest.z;
      clampLength3(_fpd, 0.8);
      dx = _fpd.x * follow;
      dy = _fpd.y * follow;
      dz = _fpd.z * follow;
    }
    const e = this.fpxEyeCur;
    // Swimming (v1.8): the eye drops with the water sink (the head-follow above already carries `follow` of it), so the view
    // sits lower in the pool. Exactly 0 on land (bodyRoot is never offset there).
    let swimDy = 0;
    const sunk = -this.bodyRoot.position.y;
    if (sunk > 1e-6) swimDy = -sunk * Math.max(0, SWIM_EYE_FRACTION - (tr !== null && follow > 0 ? follow : 0));
    eyeWorldOffset(this.root.rotation.y, e.side + dx, e.up + dy + swimDy, e.forward + dz, _fpo);
    out.rootX = this.root.position.x;
    out.rootY = this.root.position.y;
    out.rootZ = this.root.position.z;
    out.relX = _fpo.x;
    out.relY = _fpo.y;
    out.relZ = _fpo.z;
    const bob = prof.bob ?? 0.02;
    const k = this.fpxBobK;
    out.bobY = runBob(this.fpxGait, bob, k) + Math.sin(this.fpxIdleT * 1.7) * (prof.idleSway ?? 0.006) * (1 - k);
    out.bobSide = runSway(this.fpxGait, bob, k);
    out.roll = Math.sin(this.fpxGait) * 0.006 * k;
    out.near = prof.nearPlane;
    return true;
  }

  /** Per-frame FP bookkeeping: pose weight, eased eye, bob intensity. */
  private fpxTick(state: FighterState, speed: number, dt: number): void {
    const prof = this.fpxPose;
    if (prof === null) return;
    const ult = state.action === 'ultimate';
    if (ult !== this.fpxUlt) {
      this.fpxUlt = ult;
      this.fpxClipSync();
      // `ultHide`: more parts (the body, hind legs, tail …) are hidden while the own ultimate runs.
      if (this.fpxHiddenOn && prof.ultHide !== undefined && this.fpxProfile !== null) this.fpxBuildIndex(this.fpxProfile);
    }
    const target = this.fpxProfile !== null ? 1 : 0;
    this.fpxW += (target - this.fpxW) * Math.min(1, dt * 9);
    if (target === 0 && this.fpxW < 0.01) {
      this.fpxW = 0;
      this.fpxPose = null;
      this.fpxTrack = null;
      this.fpxAnch.length = 0;
      return;
    }
    if (this.fpxProfile === null) return; // fading out: eye no longer sampled
    // Eye target = profile eye + per-action offset; eased so switches never pop.
    const ea = prof.eyeAction !== undefined ? prof.eyeAction[state.action] : undefined;
    const tf = prof.eye.forward + (ea?.forward ?? 0);
    const tu = prof.eye.up + (ea?.up ?? 0);
    const ts = prof.eye.side + (ea?.side ?? 0);
    const c = this.fpxEyeCur;
    if (!this.fpxEyeInit) {
      c.forward = tf;
      c.up = tu;
      c.side = ts;
      this.fpxEyeInit = true;
    } else {
      const k = 1 - Math.exp(-dt * 9);
      c.forward += (tf - c.forward) * k;
      c.up += (tu - c.up) * k;
      c.side += (ts - c.side) * k;
    }
    const runK = state.action === 'run' && speed > 0.08 && !state.airborne ? Math.min(1, speed / this.def.speed) : 0;
    this.fpxBobK += (runK - this.fpxBobK) * (1 - Math.exp(-dt * 10));
    this.fpxGait = this.gaitPhase;
    this.fpxIdleT += dt;
    this.fpxDt = dt;
  }

  /** Run the profile's FP-only pose hook over the freshly-posed joint targets and blend by the FP weight. */
  private fpxApplyPose(state: FighterState, u: number, speed: number): void {
    const prof = this.fpxPose;
    for (let i = 0; i < this.fpxAnch.length; i++) this.fpxAnch[i].req = false;
    if (prof === null || prof.pose === undefined || this.fpxW < 0.004) return;
    const list = this.jointList;
    const n = list.length;
    if (this.fpxPre === null) this.fpxPre = new Float32Array(n * 7);
    const pre = this.fpxPre;
    for (let i = 0; i < n; i++) {
      const j = list[i];
      const o = i * 7;
      pre[o] = j.rx;
      pre[o + 1] = j.ry;
      pre[o + 2] = j.rz;
      pre[o + 3] = j.px;
      pre[o + 4] = j.py;
      pre[o + 5] = j.pz;
      pre[o + 6] = j.s;
    }
    if (this.fpxCtx === null) {
      const names = this.fpxNames as Map<string, Joint>;
      const dummy = this.fpxDummy as Joint;
      this.fpxCtx = {
        action: state.action,
        u: 0,
        state,
        speed: 0,
        t: 0,
        gait: 0,
        look: 0,
        run: 0,
        j: (name: string) => names.get(name),
        J: (name: string) => names.get(name) ?? dummy,
        limb: (name: string, spec: FpLimb) => {
          const j = names.get(name);
          if (j === undefined) return;
          let a = this.fpxAnch.find((e) => e.j === j);
          if (a === undefined) {
            a = { j, x: 0, y: 0, z: 0, down: 0, out: 0, roll: 0, w: 1, axis: 0, req: false, wCur: 0 };
            this.fpxAnch.push(a);
          }
          a.x = spec.x;
          a.y = spec.y;
          a.z = spec.z;
          a.down = spec.down;
          a.out = spec.out;
          a.roll = spec.roll ?? 0;
          a.w = spec.w ?? 1;
          a.axis = spec.axis === '+x' ? 1 : spec.axis === '-x' ? 2 : 0;
          a.req = true;
        },
      };
    }
    const ctx = this.fpxCtx;
    ctx.action = state.action;
    ctx.u = u;
    ctx.state = state;
    ctx.speed = speed;
    ctx.t = this.timePhase;
    ctx.gait = this.gaitPhase;
    ctx.look = this.fpxLook;
    ctx.run = Math.min(1, speed / this.def.speed);
    (this.fpxDummy as Joint).reset();
    prof.pose(ctx);
    const w = smooth01(this.fpxW);
    if (w >= 0.999) return;
    for (let i = 0; i < n; i++) {
      const j = list[i];
      const o = i * 7;
      j.rx = pre[o] + (j.rx - pre[o]) * w;
      j.ry = pre[o + 1] + (j.ry - pre[o + 1]) * w;
      j.rz = pre[o + 2] + (j.rz - pre[o + 2]) * w;
      j.px = pre[o + 3] + (j.px - pre[o + 3]) * w;
      j.py = pre[o + 4] + (j.py - pre[o + 4]) * w;
      j.pz = pre[o + 5] + (j.pz - pre[o + 5]) * w;
      j.s = pre[o + 6] + (j.s - pre[o + 6]) * w;
    }
  }

  /**
   * Pin the profile's `limb()` joints to the camera (FPS-style viewmodel). Call
   * once per frame AFTER the CameraRig update and BEFORE rendering, with the
   * camera's world position, the view yaw, the look pitch (+ = up) and the
   * eased FP camera amount (0..1) so the pin blends in with the transition.
   */
  fpxAnchorPass(cx: number, cy: number, cz: number, yaw: number, look: number, amount: number): void {
    const list = this.fpxAnch;
    const prof = this.fpxPose;
    // The ultimate director slid the eye away from the body (a blink): the own body would be seen from outside for a few
    // frames, so while the slide is large the whole rig is discarded (only for the animals with an ult-only clear zone). Done
    // here, right before the render, so it uses this frame's director output (no one-frame lag).
    if (this.fpxClip !== null) {
      const off =
        prof !== null && this.fpxUlt && this.fpxHiddenOn && prof.ultClip !== undefined && ultClock.casting && ultClock.slide > SLIDE_HIDE;
      if (off !== this.fpxClip.hidingAll) this.fpxClip.hideAll(off);
    }
    if (list.length === 0 || prof === null) return;
    const camW = smooth01(amount);
    // Ease every pin toward its target (requested → 1, dropped → 0) and forget finished ones.
    const k = 1 - Math.exp(-this.fpxDt * 12);
    for (let i = list.length - 1; i >= 0; i--) {
      const an = list[i];
      an.wCur += ((an.req ? 1 : 0) - an.wCur) * k;
      if (!an.req && an.wCur < 0.01) list.splice(i, 1);
    }
    if (camW <= 0.001 || list.length === 0) return;
    this.root.updateMatrixWorld(true);
    // During the own ultimate a profile may lock the viewmodel to the camera's real (director-composed) pitch.
    const locked = this.fpxUlt && prof.ultViewLock === true && ultClock.casting;
    const a = locked ? ultClock.view : look * (prof.viewPitch ?? 0.7);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const sy = Math.sin(yaw);
    const cyw = Math.cos(yaw);
    _ar.set(-cyw, 0, sy);
    _af.set(sy * ca, sa, cyw * ca);
    _au.crossVectors(_ar, _af);
    for (let i = 0; i < list.length; i++) {
      const an = list[i];
      const node = an.j.node;
      const par = node.parent;
      if (par === null) continue;
      _ap.set(cx, cy, cz).addScaledVector(_ar, an.x).addScaledVector(_au, an.y).addScaledVector(_af, an.z);
      const cd = Math.cos(an.down);
      const sd = Math.sin(an.down);
      _ad.set(0, 0, 0)
        .addScaledVector(_ar, Math.sin(an.out) * cd)
        .addScaledVector(_au, -sd)
        .addScaledVector(_af, Math.cos(an.out) * cd);
      if (an.axis === 0) {
        // Shaft = local −Y (hanging limbs); toes / palm face local +Z.
        _by.copy(_ad).negate();
        _bz.copy(_af).addScaledVector(_ad, -_af.dot(_ad));
        if (_bz.lengthSq() < 1e-6) _bz.copy(_ar);
        _bz.normalize();
        if (an.roll !== 0) _bz.applyAxisAngle(_by, an.roll);
        _bx.crossVectors(_by, _bz);
      } else {
        // Shaft = local ±X (wings): local +Y stays as close to the view's up as possible.
        _bx.copy(_ad);
        if (an.axis === 2) _bx.negate();
        _by.copy(_au).addScaledVector(_ad, -_au.dot(_ad));
        if (_by.lengthSq() < 1e-6) _by.copy(_af);
        _by.normalize();
        if (an.roll !== 0) _by.applyAxisAngle(_ad, an.roll);
        _bz.crossVectors(_bx, _by);
      }
      _am.makeBasis(_bx, _by, _bz);
      _aq.setFromRotationMatrix(_am);
      _pm.copy(par.matrixWorld);
      _pm.decompose(_pp, _pq, _ps);
      _pq.invert();
      _pm.invert();
      _ap.applyMatrix4(_pm);
      _aq.premultiply(_pq);
      const w = camW * an.w * an.wCur;
      if (w >= 0.999) {
        node.position.copy(_ap);
        node.quaternion.copy(_aq);
      } else {
        node.position.lerp(_ap, w);
        node.quaternion.slerp(_aq, w);
      }
    }
  }

  /**
   * Authoring aid for FP profiles: every joint name with its baked triangle
   * count and the bounding box of those triangles in rig-local REST space
   * (call on a fresh, un-posed rig). Not used at runtime.
   */
  describeJoints(): { name: string; tris: number; min: number[]; max: number[]; pivot: number[] }[] {
    const body = this.fpxBodyMesh;
    const names = this.fpxNames;
    if (body === null || names === null) return [];
    const bones = body.skeleton.bones as THREE.Object3D[];
    const geo = body.geometry;
    const si = geo.getAttribute('skinIndex');
    const pos = geo.getAttribute('position');
    const acc = new Map<number, { tris: number; min: number[]; max: number[] }>();
    for (let v = 0; v < pos.count; v++) {
      const b = si.getX(v);
      let a = acc.get(b);
      if (a === undefined) {
        a = { tris: 0, min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
        acc.set(b, a);
      }
      if (v % 3 === 0) a.tris++;
      const p = [pos.getX(v), pos.getY(v), pos.getZ(v)];
      for (let k = 0; k < 3; k++) {
        if (p[k] < a.min[k]) a.min[k] = p[k];
        if (p[k] > a.max[k]) a.max[k] = p[k];
      }
    }
    const out: { name: string; tris: number; min: number[]; max: number[]; pivot: number[] }[] = [];
    const r = (x: number): number => Math.round(x * 100) / 100;
    this.root.updateMatrixWorld(true);
    for (const [bi, a] of acc) {
      const node = bones[bi];
      const nm: string[] = [];
      if (bi === 0) nm.push('_root');
      for (const [name, j] of names) if (j.node === node) nm.push(name);
      _fpv.setFromMatrixPosition(node.matrixWorld);
      this.root.worldToLocal(_fpv);
      out.push({
        name: nm.join('|') || `bone${bi}`,
        tris: a.tris,
        min: a.min.map(r),
        max: a.max.map(r),
        pivot: [r(_fpv.x), r(_fpv.y), r(_fpv.z)],
      });
    }
    return out;
  }

  // ── Champions League hook (src/brawl/render/pose) ───────────────────────────
  // Additive: the Battle Royale path (`update()` and everything above) never touches these. The pose layer drives the
  // joints itself (named, per-animal limb-role profiles) and uses the Joint snapshot machinery for the cross-fade.

  private brawlKey = '';
  private brawlT = 0;
  private brawlLen = 0;
  private brawlScratch: FighterState | null = null;

  /** Every joint the subclass stored on itself, by property name (`body`, `head`, `jaw`, `legs.0`, …). */
  brawlJoints(): Map<string, Joint> {
    if (this.fpxNames === null) this.fpxResolveNames();
    return this.fpxNames as Map<string, Joint>;
  }

  /** The Battle Royale top speed (m/s) the rig's gait is normalised to. */
  brawlSpeedRef(): number {
    return this.def.speed;
  }

  /** Advance the ambient clocks (idle breathing, gait phase ∝ ground speed in m/s). */
  brawlTick(dt: number, groundSpeed: number): void {
    const d = dt < 0 ? 0 : dt > 0.1 ? 0.1 : dt;
    this.timePhase += d;
    this.idlePhase += d * 1.7;
    this.gaitPhase += d * groundSpeed * this.strideRate * Math.PI * 2;
  }

  /**
   * Write the rig's OWN idle / run / jump pose of this animal into the joint targets (call inside the `brawlApply`
   * driver, which has reset them). `arg` = run speed as a fraction of the top speed (run), vertical speed (jump).
   */
  brawlBase(kind: 'idle' | 'run' | 'jump', arg = 0): void {
    switch (kind) {
      case 'idle':
        this.poseIdle(this.idlePhase);
        break;
      case 'run':
        this.poseRun(Math.max(0.01, arg) * this.def.speed);
        break;
      case 'jump': {
        if (this.brawlScratch === null) this.brawlScratch = makeMockState(this.def.id);
        this.brawlScratch.vel.y = arg;
        this.brawlScratch.airborne = true;
        this.poseJump(this.brawlScratch);
        break;
      }
    }
  }

  /**
   * Reset every joint target, run `driver` (writes the pose through `brawlJoints()`), then apply with a cross-fade from the
   * pose that was on screen when `key` changed. `blendSec` is the per-call blend length (a 5-frame move still blends 2–3
   * frames); `capRad` caps the per-call rotation change of every joint (the smoothness safety net, 0 = off).
   */
  brawlApply(driver: (joints: ReadonlyMap<string, Joint>) => void, dt: number, key: string, blendSec: number, capRad: number): void {
    const list = this.jointList;
    const d = dt < 0 ? 0 : dt > 0.1 ? 0.1 : dt;
    if (key !== this.brawlKey) {
      for (let i = 0; i < list.length; i++) list[i].snapshot();
      this.brawlKey = key;
      this.brawlT = d;
      this.brawlLen = blendSec > 0 ? blendSec : 0;
    } else this.brawlT += d;
    this.bodyRoot.visible = true;
    this.mound.visible = false;
    for (let i = 0; i < list.length; i++) list[i].reset();
    driver(this.brawlJoints());
    let f = 1;
    if (this.brawlLen > 1e-6 && this.brawlT < this.brawlLen) {
      const t = this.brawlT / this.brawlLen;
      f = 0.5 * t + 0.5 * smooth01(t);
    }
    for (let i = 0; i < list.length; i++) list[i].applyBrawl(f, capRad);
  }

  private applyQuality(): void {
    this.qualityVer = getQualityVersion();
    this.outlineOn = tierProfile().outlines;
    if (this.outlineWidth !== null) {
      const base = 0.021 * this.outlineScale;
      this.outlineWidth.value = base;
    }
    if (this.outlineMesh !== null) this.outlineMesh.visible = this.outlineOn && this.curOpacity > 0.97 && !this.outlineClip;
  }

  /** v1.3 FP ult: hide / restore the outline hull while the first-person camera sits inside this rig. */
  setOutlineClip(clip: boolean): void {
    if (clip === this.outlineClip) return;
    this.outlineClip = clip;
    if (this.outlineMesh !== null) this.outlineMesh.visible = this.outlineOn && this.curOpacity > 0.97 && !clip;
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
    const u0 = state.actionDur > 1e-6 ? Math.min(1, state.actionT / state.actionDur) : 0;
    if (state.action !== this.prevAction || state.actionT + 0.05 < this.prevActionT) {
      for (let i = 0; i < this.jointList.length; i++) this.jointList[i].snapshot();
      this.fadeT = 0;
      if (state.action === 'dead') this.deathT = 0;
      const was = this.prevAction;
      if ((was === 'jump' || was === 'glide') && state.action !== 'jump' && state.action !== 'glide' && state.inWater !== true) {
        const sink = getFxSink(); // (landing IN the pool: the scene's splash event replaces the dust)
        if (sink !== null) sink.land(this.root, this.root.position.x, this.root.position.z, 0.9 + this.def.radius * 0.5);
      }
      this.prevAction = state.action;
      this.prevU = 0;
    }
    this.prevActionT = state.actionT;
    this.emitFx(state, u0, speed);
    this.prevU = u0;
    if (getQualityVersion() !== this.qualityVer) this.applyQuality();
    this.fadeT += dt;
    if (state.action === 'dead') this.deathT += dt;
    if (this.fpxPose !== null) this.fpxTick(state, speed, dt);
    if (state.inWater === true || this.swimBlend > 0) this.swimStep(state, dt, speed);

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
      if (this.swimBlend > 0) this.swimLayer(state, u, speed);
      else if (this.swimSunk) this.swimClear();
      if (this.fpxPose !== null) this.fpxApplyPose(state, u, speed);
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
    this.lastTransparent = transparent;
    if (this.depthMesh !== null) this.depthMesh.visible = transparent && !this.fpxDepthOff;
    if (this.outlineMesh !== null) this.outlineMesh.visible = this.outlineOn && o > 0.97 && !this.outlineClip;
  }

  /** Footfall dust, slam decals (at the exact animation instant). */
  private emitFx(state: FighterState, u: number, speed: number): void {
    const sink = getFxSink();
    if (sink === null) return;
    const x = this.root.position.x;
    const z = this.root.position.z;
    if (state.action === 'run' && this.stepScale > 0 && speed > 1.2 && !state.airborne && state.inWater !== true) {
      const step = Math.floor(this.gaitPhase / Math.PI);
      if (step !== this.lastStep) {
        this.lastStep = step;
        sink.footstep(this.root, x, z, this.stepScale * (0.6 + 0.4 * Math.min(1, speed / this.def.speed)));
      }
    }
    // Swimming: the basic-attack impact throws a splash at the exact animation instant (once per swing).
    if (state.inWater === true && !state.airborne && this.prevU < SWIM_IMPACT_U && u >= SWIM_IMPACT_U) {
      const a = state.action;
      if (a === 'attack1' || a === 'attack2' || a === 'attack3') {
        const n = a === 'attack1' ? 1 : a === 'attack2' ? 2 : 3;
        const sp = swimSplash(n, this.def.radius, this.swim.splash);
        const yaw = this.root.rotation.y;
        sink.splash?.(this.root, x + Math.sin(yaw) * sp.forward, z + Math.cos(yaw) * sp.forward, sp.radius, sp.strength);
      }
    }
    for (let i = 0; i < this.slams.length; i++) {
      const s = this.slams[i];
      if (s.action !== state.action) continue;
      if (this.prevU < s.at && u >= s.at) {
        const yaw = this.root.rotation.y;
        sink.slam(this.root, x + Math.sin(yaw) * s.forward, z + Math.cos(yaw) * s.forward, s.radius, this.accent, s.kind);
      }
    }
  }

  // ── Swimming (v1.8 WP-J4) ──────────────────────────────────────────────────
  // The swim layer runs AFTER the normal pose and BEFORE the joint cross-fade, driven only by `FighterState.inWater` (+ action,
  // actionT / actionDur, vel). With `inWater` absent / false the blend stays at exactly 0 and nothing below ever runs, so the
  // colosseum and the Champions League hooks are bit-identical to before.

  /** Advance the water blend (≈ 0.15 s), the paddle cadence and the throttled wake FX. */
  private swimStep(state: FighterState, dt: number, speed: number): void {
    const want = state.inWater === true && !state.airborne && state.action !== 'burrowed';
    if (want) this.swimBlend = Math.min(1, this.swimBlend + dt / SWIM_BLEND_S);
    else this.swimBlend = Math.max(0, this.swimBlend - dt / (state.airborne ? SWIM_BLEND_AIR_S : SWIM_BLEND_S));
    if (this.swimBlend <= 0) {
      this.swimMv = 0;
      return;
    }
    const tune = this.swim;
    this.swimMv += (Math.min(1, speed / (this.swimTop * 0.9)) - this.swimMv) * (1 - Math.exp(-dt * 8));
    this.swimPhase += dt * (tune.freqMin + (tune.freqMax - tune.freqMin) * this.swimMv) * Math.PI * 2;
    if (this.swimPhase > SWIM_PHASE_WRAP) this.swimPhase -= SWIM_PHASE_WRAP;
    if (want && speed > 0.4) {
      this.swimWakeT += dt;
      if (this.swimWakeT >= WAKE_PERIOD_S) {
        this.swimWakeT %= WAKE_PERIOD_S;
        getFxSink()?.wake?.(this.root, this.root.position.x, this.root.position.z, speed, this.def.radius * 1.25);
      }
    } else this.swimWakeT = WAKE_PERIOD_S;
  }

  /** Back on land: undo the sink exactly. */
  private swimClear(): void {
    this.bodyRoot.position.y = 0;
    this.swimSunk = false;
    this.swimMv = 0;
  }

  private swimSave(): Float64Array {
    const list = this.jointList;
    const n = list.length;
    if (this.swimPre === null) this.swimPre = new Float64Array(n * 7);
    const pre = this.swimPre;
    for (let i = 0; i < n; i++) {
      const j = list[i];
      const o = i * 7;
      pre[o] = j.rx;
      pre[o + 1] = j.ry;
      pre[o + 2] = j.rz;
      pre[o + 3] = j.px;
      pre[o + 4] = j.py;
      pre[o + 5] = j.pz;
      pre[o + 6] = j.s;
      j.reset();
    }
    return pre;
  }

  /** Blend the freshly written water pose (in the joints) with the saved land pose by `w` (1 = all water). */
  private swimMix(pre: Float64Array, w: number): void {
    const list = this.jointList;
    for (let i = 0; i < list.length; i++) {
      const j = list[i];
      const o = i * 7;
      j.rx = pre[o] + (j.rx - pre[o]) * w;
      j.ry = pre[o + 1] + (j.ry - pre[o + 1]) * w;
      j.rz = pre[o + 2] + (j.rz - pre[o + 2]) * w;
      j.px = pre[o + 3] + (j.px - pre[o + 3]) * w;
      j.py = pre[o + 4] + (j.py - pre[o + 4]) * w;
      j.pz = pre[o + 5] + (j.pz - pre[o + 5]) * w;
      j.s = pre[o + 6] + (j.s - pre[o + 6]) * w;
    }
  }

  /** The swim layer proper: pose replacement / modification by action, then the body sink. */
  private swimLayer(state: FighterState, u: number, speed: number): void {
    const w = smooth01(this.swimBlend);
    const act = state.action;
    switch (act) {
      case 'idle':
      case 'run':
      case 'feared': {
        // The run gait / idle pose is REPLACED by the paddle pose.
        const pre = this.swimSave();
        this.poseSwim(speed, this.timePhase, this.swimMv);
        // First person: the nose-up swim pitch (body and head) would lift the shoulders / back / snout into the view, so it is mostly dropped.
        if (this.fpxProfile !== null) {
          this.body.rx *= 0.3;
          this.head.rx *= 0.3;
        }
        if (act === 'feared') {
          this.head.ry += Math.sin(this.timePhase * 13) * 0.32;
          this.head.rx += -0.1;
        }
        this.swimMix(pre, w);
        break;
      }
      case 'attack1':
      case 'attack2':
      case 'attack3': {
        // The authored swing, time-warped for the water drag (impact still at u = 0.55) + the water modifiers.
        const n = act === 'attack1' ? 1 : act === 'attack2' ? 2 : 3;
        const uw = attackWarp(u);
        const pre = this.swimSave();
        this.poseAttack(n, uw);
        this.swimAttackMods(n, u, uw);
        this.swimMix(pre, w);
        break;
      }
      case 'block': {
        const pre = this.swimSave();
        this.poseBlock(this.timePhase);
        this.swimBlockMods();
        this.swimMix(pre, w);
        break;
      }
      default:
        break; // special / ultimate / hit / stagger / knockdown / dead / grab …: the normal pose, only sunk below
    }
    let sink = this.swim.sink;
    if (act === 'knockdown' || act === 'dead') {
      // A collapsed body settles AT the water line (it floats / lies in the shallows, never below the pool floor).
      const c = Math.min(1, Math.max(0, -this.body.py / Math.max(0.05, this.hipDrop)));
      const settle = Math.min(sink, this.swim.settle);
      sink += (settle - sink) * c;
    }
    this.bodyRoot.position.y = -sink * w * poolSinkScale();
    this.swimSunk = true;
  }

  /** Lazy paddle under the authored limbs: legs that are not striking (|rx| small) keep a slow paddle cycle. */
  private swimLazyLegs(amp: number): void {
    const n = Math.min(this.legs.length, 4);
    const s = this.swim;
    for (let i = 0; i < n; i++) {
      const cur = this.legs[i].rx;
      const k = smooth01(Math.abs(cur) / 0.5); // 1 = the authored striking / bracing limb
      const pad = s.tuck + Math.sin(this.swimPhase + GAIT_OFF[i]) * s.legAmp * amp;
      this.legs[i].rx = pad + (cur - pad) * k;
    }
  }

  /**
   * Attack-while-swimming modifiers on top of the authored swing (already evaluated at the warped progress `uw`): rear back /
   * pitch up on the windup, lunge further into the strike, a stronger recoil in the follow-through, lazy paddling legs and a
   * tail swish; then the per-animal {@link poseSwimAttack} flavour.
   */
  private swimAttackMods(n: 1 | 2 | 3, u: number, uw: number): void {
    const c = attackCurve(uw);
    const wind = c < 0 ? -c / 0.45 : 0;
    const strike = c > 0 ? c : 0;
    const fb = followBump(u);
    const sz = 0.6 + 0.6 * this.def.radius;
    if (this.body.py < 0) this.body.py *= 0.35; // the water holds the body up: the authored dips / crouches are mostly cancelled
    if (this.body.rx > 0) this.body.rx *= 0.5; // ... and buoyancy keeps the nose from plunging (the feet would punch through the pool bed)
    this.body.rx += -0.16 * wind - 0.04 * strike - 0.1 * fb;
    this.body.py += 0.03 * wind - 0.025 * fb + Math.sin(this.timePhase * SWIM_BOB_W) * this.swim.bob * 0.6;
    this.body.pz += (0.1 * strike - 0.13 * fb) * sz;
    this.swimLazyLegs(0.4);
    if (this.tail !== null) this.tail.ry += Math.sin(this.swimPhase * 0.5 + 0.6) * this.swim.tail * 0.5;
    this.poseSwimAttack(n, u, uw);
  }

  /** Block in the water: the authored hunker, but the body stays up out of the water and the legs keep treading. */
  private swimBlockMods(): void {
    this.body.py = this.body.py * 0.3 + Math.sin(this.timePhase * SWIM_BOB_W) * this.swim.bob * 0.6;
    this.body.rx += -0.04;
    this.swimLazyLegs(0.35);
    if (this.tail !== null) this.tail.ry += Math.sin(this.swimPhase * 0.5 + 0.6) * this.swim.tail * 0.4;
  }

  /**
   * The swimming pose (idle treading + moving), written into freshly reset joints; REPLACES the run / idle pose by the swim
   * blend. `speed` m/s, `t` running clock (s), `mv` 0..1 = speed / this animal's top water speed. The default is a generic
   * quadruped dog-paddle (alternating diagonal legs, a gentle bob, nose up while moving, head and tail lifted); every animal
   * overrides it with its own flavour.
   */
  protected poseSwim(_speed: number, t: number, mv: number): void {
    const s = this.swim;
    const ph = this.swimPhase;
    const amp = s.legAmp * (s.tread + (1 - s.tread) * mv);
    const n = Math.min(this.legs.length, 4);
    for (let i = 0; i < n; i++) {
      const o = GAIT_OFF[i];
      this.legs[i].rx = s.tuck + Math.sin(ph + o) * amp * (i < 2 ? 1 : 0.75);
      this.legs[i].rz = (i % 2 === 0 ? -1 : 1) * (0.08 + 0.07 * Math.sin(ph + o + 1.6)) * (0.5 + 0.5 * mv);
    }
    const bob = Math.sin(t * SWIM_BOB_W);
    this.body.py = bob * s.bob + Math.sin(ph * 2) * s.bob * 0.4 * mv;
    this.body.rx = -s.pitch * mv + Math.sin(t * SWIM_BOB_W + 0.9) * 0.025;
    this.body.rz = Math.sin(ph) * 0.045 * mv;
    this.head.rx = -s.headUp * (0.6 + 0.4 * mv) + Math.sin(t * SWIM_BOB_W + 0.5) * 0.03;
    this.head.ry = Math.sin(t * 0.6) * 0.15;
    if (this.tail !== null) {
      this.tail.rx = -0.35;
      this.tail.ry = Math.sin(ph * 0.5 + 0.6) * s.tail;
    }
  }

  /** Per-animal flavour of the swinging attacks in the water (called last, on the already-modified pose). Default: none. */
  protected poseSwimAttack(_n: 1 | 2 | 3, _u: number, _uw: number): void {}

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
