/**
 * CameraRig (BLUEPRINT §11.5, v1.1 WP-K fixes) — third-person pointer-lock
 * orbit camera.
 *
 * - Mouse deltas are CONSUMED via {@link applyMouseDelta}; the rig never reads
 *   the mouse itself (the InputManager / demo feeds it).
 * - Pitch clamped to [−30°, +55°]; distance 6.5 m spring-smoothed (τ = 0.12 s);
 *   pivot at the followed fighter's head height; shoulder offset 0.6 m.
 * - Collision: analytic sphere-cast against the §9 arena geometry (wall circle,
 *   pillars, ground). v1.1: the wall collider sits 0.6 m inside the wall face
 *   (in front of banners/torches); when it squeezes the boom, the rig smoothly
 *   raises its pitch and pivot (up to +28° / +0.6 m) so the camera rises over
 *   the fighter instead of collapsing into it. Pillar pull-in is fast-eased
 *   (τ 0.045 s) instead of snapping; the wall/ground clamp stays hard.
 * - Spectate: 8.5 m boom, ~20° pitch, ≥2.4 m camera height, slow auto-orbit;
 *   {@link follow} switches targets with a smooth 0.5 s blend.
 * - FOV kick (render/fxBus) on ultimates / heavy hits, decays in ~0.35 s.
 * - `yaw` is public so camera-relative input can read it.
 */

import * as THREE from 'three';
import { DEG2RAD, clamp, wrapAngle } from '../core/math';
import { PILLARS, PILLAR_HEIGHT, WALL_RADIUS } from '../config/arena';
import { fovKick } from './fxBus';

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

export class CameraRig {
  /** World yaw of the camera orbit (radians). Public for camera-relative input. */
  yaw = 0;
  /** Camera elevation angle (radians), clamped [−30°, +55°]. */
  pitch = 14 * DEG2RAD;

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
    this.yaw = wrapAngle(this.yaw - dx * this.sensitivity);
    this.pitch = clamp(this.pitch + dy * this.sensitivity, PITCH_MIN, PITCH_MAX);
    this.idleT = 0;
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
    if (rawShake > 0.0005) {
      const s = rawShake > MAX_SHAKE ? MAX_SHAKE : rawShake;
      this.shakeT += dt;
      const t = this.shakeT;
      _camPos.x += Math.sin(t * 57.3) * s;
      _camPos.y += Math.sin(t * 47.1 + 2.1) * s * 0.7;
      _camPos.z += Math.sin(t * 63.7 + 4.4) * s;
    }

    this.camera.position.copy(_camPos);
    this.camera.lookAt(_pivot);

    // FOV kick (ultimates / heavy hits), decaying back to the base FOV.
    if (fovKick.deg > 0.01 || this.appliedKick !== 0) {
      fovKick.deg *= Math.exp(-dt / FOV_DECAY_TAU);
      if (fovKick.deg < 0.01) fovKick.deg = 0;
      this.appliedKick += (fovKick.deg - this.appliedKick) * Math.min(1, dt * 30);
      if (Math.abs(this.appliedKick) < 0.005 && fovKick.deg === 0) this.appliedKick = 0;
      this.camera.fov = this.baseFov + this.appliedKick;
      this.camera.updateProjectionMatrix();
    }
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
   * Analytic sphere-cast from `pivot` along `dir` (unit) against the arena
   * wall circle (height-aware: a boom crossing above the rim continues to the
   * stands), the six pillars (vertical cylinders) and the ground plane (§9
   * geometry straight from config). Writes `_hit.hard` (wall/ground/stands —
   * must never be crossed) and `_hit.soft` (pillars — eased pull-in).
   */
  private collide(pivot: THREE.Vector3, dir: THREE.Vector3, maxDist: number): void {
    let hard = maxDist;
    let soft = maxDist;
    const ox = pivot.x;
    const oy = pivot.y;
    const oz = pivot.z;
    const dx = dir.x;
    const dy = dir.y;
    const dz = dir.z;
    const a = dx * dx + dz * dz;

    if (a > 1e-8) {
      // Arena wall: stay inside radius (WALL_RADIUS − pad) unless over the rim.
      // (−WALL_DECOR: stay in front of the banners/torches/pilasters on the wall.)
      // A pivot hugging the wall may sit outside the decor margin: then the
      // collider grows to just beyond it (never past the real wall face).
      const pr = Math.hypot(ox, oz) + 0.05;
      let rw = WALL_RADIUS - CAM_PAD - WALL_DECOR;
      if (pr > rw) rw = pr < WALL_RADIUS - CAM_PAD ? pr : WALL_RADIUS - CAM_PAD;
      const tw = exitCircle(ox, oz, dx, dz, a, rw);
      if (tw >= 0 && tw < hard) hard = tw;

      // Pillars: ray vs expanded circle, honoring pillar height.
      for (let i = 0; i < PILLARS.length; i++) {
        const p = PILLARS[i];
        const ocx = ox - p.x;
        const ocz = oz - p.z;
        const rr = p.radius + CAM_PAD;
        const cc = ocx * ocx + ocz * ocz - rr * rr;
        if (cc <= 0) continue; // pivot already inside the expanded circle
        const bb = 2 * (ocx * dx + ocz * dz);
        const disc2 = bb * bb - 4 * a * cc;
        if (disc2 <= 0) continue;
        const t0 = (-bb - Math.sqrt(disc2)) / (2 * a);
        if (t0 > 0 && t0 < soft && oy + dy * t0 <= PILLAR_HEIGHT + CAM_PAD + 0.35) soft = t0;
      }
    }

    // Ground plane.
    if (dy < -1e-6) {
      const tg = (GROUND_MIN_Y - oy) / dy;
      if (tg > 0 && tg < hard) hard = tg;
    }
    _hit.hard = hard;
    _hit.soft = soft < hard ? soft : hard;
  }
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
