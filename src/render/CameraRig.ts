/**
 * CameraRig (BLUEPRINT §11.5, v1.1 WP-K fixes) — third-person pointer-lock
 * orbit camera.
 *
 * - Mouse deltas are CONSUMED via {@link applyMouseDelta}; the rig never reads
 *   the mouse itself (the InputManager / demo feeds it).
 * - Pitch clamped to [−30°, +55°]; distance 6.5 m spring-smoothed (τ = 0.12 s);
 *   pivot at the followed fighter's head height; shoulder offset 0.6 m.
 * - Collision: analytic sphere-cast against the §9 arena geometry (wall circle,
 *   pillars, ground). v1.8: the wall radius and the round blockers come from the CURRENT arena
 *   (`render/arenaContext`, set by `SceneManager.setArena`); for the colosseum those are the same
 *   numbers as before. Jungle TREE trunks never pull the boom in (they fade out instead, see
 *   `render/jungle/treeFade.ts`); only a camera that would END inside a trunk is eased back. v1.1: the wall collider sits 0.6 m inside the wall face
 *   (in front of banners/torches); when it squeezes the boom, the rig smoothly
 *   raises its pitch and pivot (up to +28° / +0.6 m) so the camera rises over
 *   the fighter instead of collapsing into it. Pillar pull-in is fast-eased
 *   (τ 0.045 s) instead of snapping; the wall/ground clamp stays hard.
 * - Spectate: 8.5 m boom, ~20° pitch, ≥2.4 m camera height, slow auto-orbit;
 *   {@link follow} switches targets with a smooth 0.5 s blend.
 * - FOV kick (render/fxBus) on ultimates / heavy hits, decays in ~0.35 s.
 * - `yaw` is public so camera-relative input can read it.
 *
 * v1.3 WP-Q — FIRST-PERSON mode ({@link setFirstPerson}): the camera sits at the
 * followed rig's eye (a {@link FpEyeSample} supplied by `setFpAnchor`), is
 * driven ONLY by `yaw` + `fpPitch` (±80°) plus a small decaying hit-kick and a
 * tiny run roll, and therefore can never inherit body roll / pitch / spin. The
 * root position is used un-smoothed (no lag); only the eye's offset from it is
 * smoothed lightly. Mode switches blend the third-person transform into the
 * first-person one over ~0.4 s (position lerp + quaternion slerp + FOV/near
 * lerp), so there is no pop. Spectate / death always forces third person.
 */

import * as THREE from 'three';
import { DEG2RAD, clamp, wrapAngle } from '../core/math';
import { fovKick } from './fxBus';
import { getRenderArena } from './arenaContext';
import type { ArenaDef } from '../config/arenas';
import type { FpEyeSample } from './animals/fp/types';
import { UltCamOut } from './animals/fp/ultCam'; // v1.3 FP ult: ultimate camera director output
import {
  FP_FOV_DEFAULT,
  ViewKick,
  clampEyeToArena,
  clampFpFov,
  clampFpPitch,
  fpVerticalFov,
  smoothStep01,
  stepBlend,
} from './animals/fp/math';

/** Fills the local player's first-person eye sample each frame. */
export type FpAnchorFn = (out: FpEyeSample) => void;

/** Writes the current world position of the followed target into `out`. */
export type TargetPosFn = (out: THREE.Vector3) => void;

export interface CameraRigOptions {
  /** Desired orbit distance (m). Default 6.5 (§11.5). */
  distance?: number;
  /** Shoulder offset to camera-right (m). Default 0.6 (§11.5). */
  shoulderOffset?: number;
  /** Radians of yaw/pitch per pixel of mouse movement. Default 0.0024. */
  sensitivity?: number;
  /** Pivot height used before the first `follow()` call. Default 1.6. */
  pivotHeight?: number;
}

const PITCH_MIN = -30 * DEG2RAD;
const PITCH_MAX = 55 * DEG2RAD;
const DIST_TAU = 0.12; // spring smoothing time constant (§11.5)
const PULL_TAU = 0.045; // eased pull-in for soft (pillar) obstacles
const BLEND_DUR = 0.5; // target-switch transition (§11.5)
const CAM_PAD = 0.35; // sphere-cast radius
const MIN_DIST = 0.9;
const GROUND_MIN_Y = 0.28;
const MAX_SHAKE = 0.15; // §11.4 screenshake cap (m)

// Wall squeeze assist.
const SQUEEZE_PITCH = 28 * DEG2RAD;
const SQUEEZE_LIFT = 0.6;
const SQUEEZE_TAU = 0.18;
const WALL_DECOR = 0.6; // banners / torches / pilasters stand ≤0.6 m proud of the wall

// Spectate framing.
const SPECTATE_DIST = 8.5;
const SPECTATE_PITCH = 20 * DEG2RAD;
const SPECTATE_MIN_Y = 2.4;

const FOV_DECAY_TAU = 0.12;

// Scratch (no per-frame allocation).
const _target = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _hit = { hard: 0, soft: 0 };

// First-person scratch.
const FP_REL_TAU = 0.035; // eye-offset smoothing (s); root position is NOT smoothed
const FP_TP_NEAR = 0.1; // the third-person near plane (SceneManager's value)
const ULT_PITCH_MAX = 1.5; // hard pitch limit (~86 degrees) with the ultimate director's offsets applied
const _tpPos = new THREE.Vector3();
const _tpQuat = new THREE.Quaternion();
const _fpPos = new THREE.Vector3();
const _fpQuat = new THREE.Quaternion();
const _lookM = new THREE.Matrix4();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _up = new THREE.Vector3(0, 1, 0);
const _off = { x: 0, z: 0 };

export class CameraRig {
  /** World yaw of the camera orbit (radians). Public for camera-relative input. */
  yaw = 0;
  /** Camera elevation angle (radians), clamped [−30°, +55°]. */
  pitch = 14 * DEG2RAD;
  /**
   * First-person look pitch (radians, + = looking UP), clamped ±80°. Separate
   * from the orbit `pitch` so switching modes never fights the other mapping.
   */
  fpPitch = 0;

  /**
   * Screenshake hook: the rig applies `min(shakeSource(), 0.15)` metres of
   * positional noise each frame. Wire to `Effects.getShakeOffset`.
   */
  shakeSource: (() => number) | null = null;

  readonly camera: THREE.PerspectiveCamera;

  private readonly baseDistance: number;
  private readonly shoulder: number;
  private readonly sensitivity: number;
  private readonly baseFov: number;

  private getTarget: TargetPosFn | null = null;
  private headHeight: number;

  private dist: number;
  private spectateMode = false;
  private idleT = 0;
  private shakeT = 0;
  private squeeze = 0; // 0..1 wall-squeeze assist amount (smoothed)
  private appliedKick = 0;

  // Smooth 0.5 s blend between targets (spectate hand-offs).
  private blendT = 1; // 1 = no blend in progress
  private readonly blendFrom = new THREE.Vector3();
  private blendFromHead = 1.6;

  // ── First person (WP-Q) ──
  private fpWanted = false; // requested mode
  private fpBlend = 0; // 0 = third person … 1 = first person (linear in time)
  private fpAnchor: FpAnchorFn | null = null;
  private fpFovH = FP_FOV_DEFAULT; // horizontal FOV setting (deg)
  private fpNear = 0.08; // near plane from the active profile
  private fpRelInit = false;
  private tpPitchSaved = 14 * DEG2RAD;
  private readonly fpSample: FpEyeSample = {
    rootX: 0, rootY: 0, rootZ: 0, relX: 0, relY: 1.4, relZ: 0, bobY: 0, bobSide: 0, roll: 0, near: 0.08,
  };
  private fpRelX = 0;
  private fpRelY = 1.4;
  private fpRelZ = 0;
  /** Hit-kick spring (pitch/roll), applied in first person only. */
  readonly viewKick = new ViewKick();
  /**
   * v1.3 FP ult: the first-person ULTIMATE camera director's output (fp/ultCam.ts), written by the
   * MatchController each frame. Neutral (all zeros / ones) outside an ultimate; only ever applied to the
   * first-person transform, as view-only offsets on top of the player's own yaw/pitch.
   */
  readonly ult = new UltCamOut();
  private lastNear = FP_TP_NEAR;
  private lastFov = 0;

  constructor(camera: THREE.PerspectiveCamera, options: CameraRigOptions = {}) {
    this.camera = camera;
    this.baseDistance = options.distance ?? 6.5;
    this.shoulder = options.shoulderOffset ?? 0.6;
    this.sensitivity = options.sensitivity ?? 0.0024;
    this.headHeight = options.pivotHeight ?? 1.6;
    this.baseFov = camera.fov;
    this.dist = this.baseDistance;
  }

  /** Feed pointer-lock mouse deltas (pixels). The rig never reads the mouse. */
  applyMouseDelta(dx: number, dy: number): void {
    // v1.3 FP ult: a directive may (briefly) lock the mouse look; 1 = free.
    const ux = this.fpWanted ? this.ult.mouseYaw : 1;
    const uy = this.fpWanted ? this.ult.mousePitch : 1;
    this.yaw = wrapAngle(this.yaw - dx * this.sensitivity * ux);
    if (this.fpWanted) {
      // First person: mouse down = look down (same feel as the orbit camera).
      this.fpPitch = clampFpPitch(this.fpPitch - dy * this.sensitivity * uy);
    } else {
      this.pitch = clamp(this.pitch + dy * this.sensitivity, PITCH_MIN, PITCH_MAX);
    }
    this.idleT = 0;
  }

  // ── First person (WP-Q) ───────────────────────────────────────────────────

  /** True while first person is the requested mode (spectate/death force it off). */
  get isFirstPerson(): boolean {
    return this.fpWanted;
  }

  /** 0..1 eased mode blend (0 = third person, 1 = first person) — for hiding the own head. */
  get fpAmount(): number {
    return smoothStep01(this.fpBlend);
  }

  /** Supply the callback that samples the local player's eye every frame. */
  setFpAnchor(fn: FpAnchorFn | null): void {
    this.fpAnchor = fn;
  }

  /** Horizontal FOV (degrees) used in first person; clamped to 60–110. */
  setFpFov(horizontalDeg: number): void {
    this.fpFovH = clampFpFov(horizontalDeg);
  }

  /**
   * Switch mode. Entering first person keeps the current view direction's
   * yaw and starts from a near-level pitch; leaving restores the previous
   * orbit pitch. `immediate` skips the ~0.4 s blend (mount / restore).
   * Spectating never allows first person.
   */
  setFirstPerson(on: boolean, immediate = false): void {
    const want = on && !this.spectateMode;
    if (want === this.fpWanted) {
      if (immediate) this.fpBlend = want ? 1 : 0;
      return;
    }
    this.fpWanted = want;
    if (want) {
      this.tpPitchSaved = this.pitch;
      this.fpPitch = clampFpPitch(-this.pitch * 0.25);
      this.fpRelInit = false;
    } else {
      this.pitch = clamp(this.tpPitchSaved, PITCH_MIN, PITCH_MAX);
    }
    if (immediate) this.fpBlend = want ? 1 : 0;
  }

  /** Hit "view kick" (radians): a brief pitch/roll jolt instead of body motion. */
  addKick(pitch: number, roll: number): void {
    if (this.fpWanted) this.viewKick.kick(pitch, roll);
  }

  /**
   * Follow a target. Switching to a DIFFERENT target function triggers a
   * smooth 0.5 s pivot transition (used for spectate target cycling).
   * `headHeight` is the pivot height above the target position (§11.5,
   * per-animal ~1.2–2.6 m).
   */
  follow(getTargetPos: TargetPosFn, headHeight: number): void {
    if (this.getTarget !== null && this.getTarget !== getTargetPos) {
      // Capture the CURRENT effective pivot base so the blend starts where
      // the camera is now, even mid-blend.
      this.evalBase(_target);
      this.blendFrom.copy(_target);
      this.blendFromHead = this.effectiveHead();
      this.blendT = 0;
    }
    this.getTarget = getTargetPos;
    this.headHeight = headHeight;
  }

  /** Spectate mode: wider/higher framing; slow orbit after 1.5 s idle. */
  setSpectate(on: boolean): void {
    this.spectateMode = on;
    // The death cam / spectating is always third person (WP-Q).
    if (on && this.fpWanted) this.setFirstPerson(false);
  }

  get isSpectate(): boolean {
    return this.spectateMode;
  }

  /** Advance smoothing/blending and place the camera. Call once per frame. */
  update(dt: number): void {
    if (this.getTarget === null) return;

    if (this.blendT < 1) this.blendT = Math.min(1, this.blendT + dt / BLEND_DUR);

    this.idleT += dt;
    const desired = this.spectateMode ? SPECTATE_DIST : this.baseDistance;
    if (this.spectateMode) {
      // Ease toward a readable overview pitch unless the player is steering.
      if (this.idleT > 0.6) this.pitch += (SPECTATE_PITCH - this.pitch) * (1 - Math.exp(-dt / 0.6));
      if (this.idleT > 1.5) this.yaw = wrapAngle(this.yaw - dt * 0.22);
    }

    // Pivot = blended target position + head height + shoulder offset.
    this.evalBase(_pivot);
    const head = this.effectiveHead();
    _pivot.y += head + this.squeeze * SQUEEZE_LIFT;
    const cosYaw = Math.cos(this.yaw);
    const sinYaw = Math.sin(this.yaw);
    _pivot.x += -cosYaw * this.shoulder; // camera-right = forward × up = (−cos yaw, 0, sin yaw)
    _pivot.z += sinYaw * this.shoulder;

    // Squeeze assist: how much of the boom the wall steals at the BASE pitch
    // (measured un-lifted so the assist cannot feed back on itself).
    let cp = Math.cos(this.pitch);
    let sp = Math.sin(this.pitch);
    _dir.set(-sinYaw * cp, sp, -cosYaw * cp);
    this.collide(_pivot, _dir, desired);
    const need = _hit.hard < desired ? 1 - _hit.hard / desired : 0;
    const sq = need > 0.1 ? Math.min(1, (need - 0.1) / 0.55) : 0;
    this.squeeze += (sq - this.squeeze) * (1 - Math.exp(-dt / SQUEEZE_TAU));

    // Orbit direction from pivot toward the camera (pitch lifted by squeeze).
    const pitch = Math.min(PITCH_MAX + 12 * DEG2RAD, this.pitch + this.squeeze * SQUEEZE_PITCH);
    cp = Math.cos(pitch);
    sp = Math.sin(pitch);
    _dir.set(-sinYaw * cp, sp, -cosYaw * cp);
    this.collide(_pivot, _dir, desired);
    const hard = _hit.hard;
    const soft = _hit.soft;

    // Spring toward the desired distance; soft obstacles ease in, hard clamp.
    this.dist += (desired - this.dist) * (1 - Math.exp(-dt / DIST_TAU));
    if (this.dist > soft) this.dist += (soft - this.dist) * (1 - Math.exp(-dt / PULL_TAU));
    if (this.dist > hard) this.dist = hard;
    if (this.dist < MIN_DIST) this.dist = MIN_DIST;

    _camPos.copy(_pivot).addScaledVector(_dir, this.dist);
    if (_camPos.y < GROUND_MIN_Y) _camPos.y = GROUND_MIN_Y;
    if (this.spectateMode && _camPos.y < SPECTATE_MIN_Y) _camPos.y = SPECTATE_MIN_Y;

    // Screenshake (≤0.15 m), applied as a positional offset.
    const rawShake = this.shakeSource !== null ? this.shakeSource() : 0;
    let shakeAmt = 0;
    if (rawShake > 0.0005) {
      const s = rawShake > MAX_SHAKE ? MAX_SHAKE : rawShake;
      shakeAmt = s;
      this.shakeT += dt;
      const t = this.shakeT;
      _camPos.x += Math.sin(t * 57.3) * s;
      _camPos.y += Math.sin(t * 47.1 + 2.1) * s * 0.7;
      _camPos.z += Math.sin(t * 63.7 + 4.4) * s;
    }

    // First person (WP-Q): blend the eye camera over the orbit camera.
    this.fpBlend = stepBlend(this.fpBlend, this.fpWanted && this.fpAnchor !== null, dt);
    let fovBase = this.baseFov;
    let nearNow = FP_TP_NEAR;
    let ultFov = 0;
    if (this.fpBlend > 0 && this.fpAnchor !== null) {
      const e = smoothStep01(this.fpBlend);
      _lookM.lookAt(_camPos, _pivot, _up);
      _tpQuat.setFromRotationMatrix(_lookM);
      _tpPos.copy(_camPos);
      this.evalFirstPerson(dt, shakeAmt);
      if (e >= 1) {
        this.camera.position.copy(_fpPos);
        this.camera.quaternion.copy(_fpQuat);
      } else {
        this.camera.position.lerpVectors(_tpPos, _fpPos, e);
        this.camera.quaternion.slerpQuaternions(_tpQuat, _fpQuat, e);
      }
      fovBase = this.baseFov + (fpVerticalFov(this.fpFovH, this.camera.aspect) - this.baseFov) * e;
      nearNow = FP_TP_NEAR + (this.fpNear - FP_TP_NEAR) * e;
      ultFov = this.ult.fovPct * e; // v1.3 FP ult
    } else {
      this.camera.position.copy(_camPos);
      this.camera.lookAt(_pivot);
      this.viewKick.update(dt); // let any residual kick settle
    }

    // FOV kick (ultimates / heavy hits), decaying back to the base FOV.
    if (fovKick.deg > 0.01 || this.appliedKick !== 0) {
      fovKick.deg *= Math.exp(-dt / FOV_DECAY_TAU);
      if (fovKick.deg < 0.01) fovKick.deg = 0;
      this.appliedKick += (fovKick.deg - this.appliedKick) * Math.min(1, dt * 30);
      if (Math.abs(this.appliedKick) < 0.005 && fovKick.deg === 0) this.appliedKick = 0;
    }
    const fov = fovBase * (1 + ultFov) + this.appliedKick;
    if (Math.abs(fov - this.lastFov) > 0.002 || Math.abs(nearNow - this.lastNear) > 0.0005) {
      this.lastFov = fov;
      this.lastNear = nearNow;
      this.camera.fov = fov;
      this.camera.near = nearNow;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * First-person camera transform → `_fpPos` / `_fpQuat`. Position = the rig's
   * exact root position + a lightly smoothed eye offset (+ un-smoothed bob and
   * shake); orientation = yaw / fpPitch / kick / run roll ONLY — the body's
   * own roll, pitch and spin never reach it.
   */
  private evalFirstPerson(dt: number, shakeAmt: number): void {
    const smp = this.fpSample;
    (this.fpAnchor as FpAnchorFn)(smp);
    if (!this.fpRelInit) {
      this.fpRelX = smp.relX;
      this.fpRelY = smp.relY;
      this.fpRelZ = smp.relZ;
      this.fpRelInit = true;
    } else {
      const k = 1 - Math.exp(-dt / FP_REL_TAU);
      this.fpRelX += (smp.relX - this.fpRelX) * k;
      this.fpRelY += (smp.relY - this.fpRelY) * k;
      this.fpRelZ += (smp.relZ - this.fpRelZ) * k;
    }
    _off.x = this.fpRelX;
    _off.z = this.fpRelZ;
    clampEyeToArena(smp.rootX, smp.rootZ, _off);
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    let y = smp.rootY + this.fpRelY + smp.bobY;
    if (y < 0.14) y = 0.14;
    _fpPos.set(
      smp.rootX + _off.x - cosY * smp.bobSide,
      y,
      smp.rootZ + _off.z + sinY * smp.bobSide,
    );
    // v1.3 FP ult: eye drop / surge / blink slide from the ultimate camera director (world-space, view-only).
    const ul = this.ult;
    if (ul.active) {
      _fpPos.x += ul.slideX + sinY * ul.eyeF;
      _fpPos.y += ul.slideY + ul.eyeY;
      _fpPos.z += ul.slideZ + cosY * ul.eyeF;
      if (_fpPos.y < 0.14) _fpPos.y = 0.14;
      const r = Math.hypot(_fpPos.x, _fpPos.z);
      const rMax = getRenderArena().wallRadius - 0.22;
      if (r > rMax) {
        _fpPos.x *= rMax / r;
        _fpPos.z *= rMax / r;
      }
    }
    // Shake: positional noise (scaled down — the eye is close to everything)
    // plus a hair of angular noise.
    let sp = 0;
    let sr = 0;
    if (shakeAmt > 0) {
      const t = this.shakeT;
      const s = shakeAmt * 0.6;
      _fpPos.x += Math.sin(t * 57.3) * s;
      _fpPos.y += Math.sin(t * 47.1 + 2.1) * s * 0.7;
      _fpPos.z += Math.sin(t * 63.7 + 4.4) * s;
      sp = Math.sin(t * 41.9 + 1.3) * shakeAmt * 0.1;
      sr = Math.sin(t * 52.3 + 3.7) * shakeAmt * 0.12;
    }
    this.viewKick.update(dt);
    // v1.3 FP ult: additive pitch offset, optional blend toward an absolute look-at pitch, then kicks / shake.
    let pitchF = clampFpPitch(this.fpPitch) + this.viewKick.pitch + sp;
    let rollF = smp.roll + this.viewKick.roll + sr;
    let yawF = this.yaw + Math.PI;
    if (ul.active) {
      pitchF += ul.pitch;
      if (ul.lookW > 0) pitchF += (ul.lookPitch - pitchF) * ul.lookW;
      pitchF += ul.kick;
      if (pitchF > ULT_PITCH_MAX) pitchF = ULT_PITCH_MAX;
      else if (pitchF < -ULT_PITCH_MAX) pitchF = -ULT_PITCH_MAX;
      rollF += ul.roll;
      yawF += ul.yawOff;
    }
    _euler.set(pitchF, yawF, rollF, 'YXZ');
    _fpQuat.setFromEuler(_euler);
    this.fpNear = smp.near;
  }

  /** Place the camera immediately (no smoothing) — call once after setup. */
  snap(): void {
    this.dist = this.spectateMode ? SPECTATE_DIST : this.baseDistance;
    this.blendT = 1;
    this.update(1 / 60);
    this.dist = Math.min(this.dist, _hit.hard);
    this.update(1 / 60);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Current blended target base position (feet), written into `out`. */
  private evalBase(out: THREE.Vector3): void {
    const fn = this.getTarget;
    if (fn === null) {
      out.set(0, 0, 0);
      return;
    }
    fn(out);
    if (this.blendT < 1) {
      const e = smooth01(this.blendT);
      out.x = this.blendFrom.x + (out.x - this.blendFrom.x) * e;
      out.y = this.blendFrom.y + (out.y - this.blendFrom.y) * e;
      out.z = this.blendFrom.z + (out.z - this.blendFrom.z) * e;
    }
  }

  private effectiveHead(): number {
    if (this.blendT >= 1) return this.headHeight;
    const e = smooth01(this.blendT);
    return this.blendFromHead + (this.headHeight - this.blendFromHead) * e;
  }

  /**
   * Analytic sphere-cast from `pivot` along `dir` (unit) against the CURRENT arena (see {@link boomCast}). Writes `_hit.hard`
   * (wall/ground — must never be crossed) and `_hit.soft` (pillars — eased pull-in).
   */
  private collide(pivot: THREE.Vector3, dir: THREE.Vector3, maxDist: number): void {
    boomCast(getRenderArena(), pivot.x, pivot.y, pivot.z, dir.x, dir.y, dir.z, maxDist, _hit);
  }
}

/**
 * The camera boom's analytic sphere-cast (pure; `CameraRig.collide` calls it with the current arena): from (ox, oy, oz) along the
 * unit direction (dx, dy, dz) up to `maxDist`, against the arena wall circle (height-aware: a boom crossing above the rim
 * continues to the stands), its round blockers (vertical cylinders: the colosseum's pillars, the jungle's tree trunks) and the
 * ground plane (§9 geometry straight from the arena data). Writes `out.hard` (wall / ground — must never be crossed) and
 * `out.soft` (blockers — eased pull-in). For the colosseum this is bit-identical to the v1.7 collision. Tree trunks are special:
 * a trunk between the pivot and the camera FADES instead (`render/jungle/treeFade.ts`), so only a boom end that would sit inside a
 * trunk is eased back.
 */
export function boomCast(
  arena: ArenaDef,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  out: { hard: number; soft: number },
): void {
  let hard = maxDist;
  let soft = maxDist;
  const a = dx * dx + dz * dz;

  if (a > 1e-8) {
    // Arena wall: stay inside radius (wallRadius − pad) unless over the rim.
    // (−WALL_DECOR: stay in front of the banners/torches/pilasters on the wall.)
    // A pivot hugging the wall may sit outside the decor margin: then the
    // collider grows to just beyond it (never past the real wall face).
    const wallR = arena.wallRadius;
    const pr = Math.hypot(ox, oz) + 0.05;
    let rw = wallR - CAM_PAD - WALL_DECOR;
    if (pr > rw) rw = pr < wallR - CAM_PAD ? pr : wallR - CAM_PAD;
    const tw = exitCircle(ox, oz, dx, dz, a, rw);
    if (tw >= 0 && tw < hard) hard = tw;

    // Round blockers (pillars / tree trunks): ray vs expanded circle, honoring their height.
    const circles = arena.circles;
    for (let i = 0; i < circles.length; i++) {
      const p = circles[i];
      const ocx = ox - p.x;
      const ocz = oz - p.z;
      const rr = p.radius + CAM_PAD;
      const cc = ocx * ocx + ocz * ocz - rr * rr;
      if (cc <= 0) continue; // pivot already inside the expanded circle
      const bb = 2 * (ocx * dx + ocz * dz);
      const disc2 = bb * bb - 4 * a * cc;
      if (disc2 <= 0) continue;
      const sq = Math.sqrt(disc2);
      const t0 = (-bb - sq) / (2 * a);
      if (t0 > 0 && t0 < soft && oy + dy * t0 <= p.height + CAM_PAD + 0.35) {
        if (p.kind === 'tree') {
          const t1 = (-bb + sq) / (2 * a);
          if (!(maxDist > t0 && maxDist < t1)) continue;
        }
        soft = t0;
      }
    }
  }

  // Ground plane.
  if (dy < -1e-6) {
    const tg = (GROUND_MIN_Y - oy) / dy;
    if (tg > 0 && tg < hard) hard = tg;
  }
  out.hard = hard;
  out.soft = soft < hard ? soft : hard;
}

/** Distance along (dx,dz) at which a ray from inside a circle exits it (−1 if none). */
function exitCircle(ox: number, oz: number, dx: number, dz: number, a: number, r: number): number {
  const b = 2 * (ox * dx + oz * dz);
  const c = ox * ox + oz * oz - r * r;
  if (c >= 0) return 0; // origin already outside: no room at all
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return -1;
  return (-b + Math.sqrt(disc)) / (2 * a);
}

function smooth01(t: number): number {
  return t * t * (3 - 2 * t);
}
