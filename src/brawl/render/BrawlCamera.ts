/**
 * Champions League camera (plan §5): perspective (~28° vertical fov), side-on with a 4° downward
 * pitch. Dynamic framing of every alive fighter + 3 m padding, the visible half-width at the z = 0 plane
 * clamped to `stage.camera`, critically-damped follow with velocity lookahead, a KO zoom pulse and a hit
 * shake scaled by launch speed (suppressed by the reduce-motion flag).
 *
 * Guarantee: an alive fighter that is "in play" (inside the stage's playfield, i.e. not already flying toward a blast
 * zone) is never outside the view — after the springs run a hard containment pass pushes the focus/zoom the
 * minimum needed. Pure number maths (no allocation per frame); `apply()` writes the three.js camera.
 */

import * as THREE from 'three';
import type { StageDef } from '../types';

export const CAM_FOV_DEG = 28;
export const CAM_PITCH_DEG = 4;
export const CAM_PAD = 3;

/** One framing target (the view reuses a pool of these; positions are the interpolated display positions). */
export interface CamTarget {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Visual height of the rig above the feet (m); tall rigs (the giraffe's neck) must stay in frame. Default 0 = use the standard body box. */
  top?: number;
}

export function makeCamTarget(): CamTarget {
  return { alive: false, x: 0, y: 0, vx: 0, vy: 0, top: 0 };
}

const TAN_HALF_FOV = Math.tan((CAM_FOV_DEG * Math.PI) / 360);
const SIN_PITCH = Math.sin((CAM_PITCH_DEG * Math.PI) / 180);
const COS_PITCH = Math.cos((CAM_PITCH_DEG * Math.PI) / 180);
/** Body centre above the feet when framing (m). */
const BODY_MID = 0.9;
const LOOK_T = 0.22;
const LOOK_MAX = 3.5;

/** Exact critically-damped spring step. Returns the new position; the new velocity is left in `spring.v`. */
const spr = { v: 0 };
function critDamp(x: number, v: number, target: number, omega: number, dt: number): number {
  const e = Math.exp(-omega * dt);
  const dx = x - target;
  const tmp = (v + omega * dx) * dt;
  spr.v = (v - omega * tmp) * e;
  return target + (dx + tmp) * e;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp into [lo, hi] when that range exists, else use `fallback`. */
function rangeClamp(v: number, lo: number, hi: number, fallback: number): number {
  return lo <= hi ? clamp(v, lo, hi) : fallback;
}

const _p = new THREE.Vector3();

export class BrawlCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** Current focus (stage space, m) and visible half-width at the z = 0 plane. */
  x: number;
  y: number;
  halfW: number;
  private vx = 0;
  private vy = 0;
  private vw = 0;
  private aspect = 16 / 9;
  /** Shake trauma 0..1 and the KO pulse 0..1 (both decay on the FX clock). */
  trauma = 0;
  koPulse = 0;
  private koX = 0;
  private koY = 0;
  private time = 0;
  /** Final (shaken) camera placement, for projection. */
  private sx = 0;
  private sy = 0;
  reduceMotion = false;
  /** Vertical band of the stage that is always kept in view (top of the highest platform + margin … just under the main slab). */
  readonly viewTop: number;
  readonly viewBot: number;
  private readonly pfL: number;
  private readonly pfR: number;
  private readonly pfB: number;
  private readonly pfT: number;
  /** Shake amplitude scale (tests / settings). */
  shakeScale = 1;
  private readonly rect = { l: 0, r: 0, b: 0, t: 0 };

  constructor(readonly stage: StageDef, camera?: THREE.PerspectiveCamera) {
    this.camera = camera ?? new THREE.PerspectiveCamera(CAM_FOV_DEG, this.aspect, 0.5, 700);
    this.camera.fov = CAM_FOV_DEG;
    let top = 0;
    for (const p of stage.platforms) top = Math.max(top, p.y + (p.moving !== undefined && p.moving.axis === 'y' ? p.moving.amplitude : 0));
    this.viewTop = top + 2.4;
    this.viewBot = -3.0;
    let px = 0;
    for (const p of stage.platforms) px = Math.max(px, Math.abs(p.x0), Math.abs(p.x1));
    this.pfL = -(px + 3);
    this.pfR = px + 3;
    this.pfB = -4;
    this.pfT = this.viewTop + 3;
    this.x = stage.cameraFocus.x;
    this.y = stage.cameraFocus.y;
    this.halfW = stage.camera.minHalfW + (stage.camera.maxHalfW - stage.camera.minHalfW) * 0.45;
    this.apply();
  }

  setAspect(a: number): void {
    this.aspect = a > 0.2 ? a : 16 / 9;
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  get halfH(): number {
    return this.halfW / this.aspect;
  }

  /** Visible rectangle at the z = 0 plane (no shake), reused object. */
  visibleRect(): { l: number; r: number; b: number; t: number } {
    const hh = this.halfH;
    const r = this.rect;
    r.l = this.x - this.halfW;
    r.r = this.x + this.halfW;
    r.b = this.y - hh;
    r.t = this.y + hh;
    return r;
  }

  /** Add shake from a hit (launch speed in m/s). */
  hit(kbSpeed: number, sweet = false): void {
    if (this.reduceMotion) return;
    const t = clamp((kbSpeed - 12) / 48, 0, 1) * (sweet ? 1.25 : 1);
    if (t <= 0) return;
    this.trauma = Math.min(1, this.trauma + t * 0.55);
  }

  /** KO: zoom pulse toward the KO position + a big shake. */
  ko(x: number, y: number): void {
    this.koPulse = 1;
    this.koX = x;
    this.koY = y;
    if (!this.reduceMotion) this.trauma = Math.min(1, this.trauma + 0.7);
  }

  /** Snap straight to the framing of `targets` (match start, no spring). */
  snap(targets: readonly CamTarget[], count: number): void {
    for (let i = 0; i < 8; i++) this.update(1 / 20, targets, count);
    this.vx = this.vy = this.vw = 0;
    this.apply();
  }

  /**
   * Advance by `dt` (FX clock seconds). `targets` are the fighters (only the first `count` entries are read).
   */
  update(dt: number, targets: readonly CamTarget[], count: number): void {
    const d = dt < 0 ? 0 : dt > 0.1 ? 0.1 : dt;
    this.time += d;
    const st = this.stage;
    const aspect = this.aspect;
    // The stage clamp is defined at 16:9; wider windows keep the same vertical coverage (the clamp scales with the aspect).
    const aw = Math.max(1, aspect / (16 / 9));
    const minW = st.camera.minHalfW * aw;
    const maxW = st.camera.maxHalfW * aw;
    const bl = st.blast;

    // Pass 1: fighter boxes (all alive, and in-play only; the stage band is handled separately).
    let aMinX = Infinity;
    let aMaxX = -Infinity;
    let aMinY = Infinity;
    let aMaxY = -Infinity;
    let pMinX = Infinity;
    let pMaxX = -Infinity;
    let pMinY = Infinity;
    let pMaxY = -Infinity;
    let nAll = 0;
    let nPlay = 0;
    for (let i = 0; i < count; i++) {
      const t = targets[i];
      if (!t.alive) continue;
      const lx = clamp(t.vx * LOOK_T, -LOOK_MAX, LOOK_MAX);
      const ly = clamp(t.vy * LOOK_T, -LOOK_MAX * 0.6, LOOK_MAX * 0.6);
      const cy = t.y + BODY_MID;
      const x0 = Math.min(t.x, t.x + lx);
      const x1 = Math.max(t.x, t.x + lx);
      const y0 = Math.min(cy, cy + ly) - 0.9;
      const y1 = Math.max(Math.max(cy, cy + ly) + 1.3, t.y + Math.max(0, ly) + (t.top ?? 0) + 0.4);
      nAll++;
      if (x0 < aMinX) aMinX = x0;
      if (x1 > aMaxX) aMaxX = x1;
      if (y0 < aMinY) aMinY = y0;
      if (y1 > aMaxY) aMaxY = y1;
      if (this.isInPlay(t)) {
        nPlay++;
        if (x0 < pMinX) pMinX = x0;
        if (x1 > pMaxX) pMaxX = x1;
        if (y0 < pMinY) pMinY = y0;
        if (y1 > pMaxY) pMaxY = y1;
      }
    }

    let tx: number;
    let ty: number;
    let tw: number;
    if (nAll === 0) {
      tx = st.cameraFocus.x;
      ty = st.cameraFocus.y;
      tw = minW + (maxW - minW) * 0.45;
    } else {
      const band = ((this.viewTop - this.viewBot) / 2) * aspect;
      const need = (x0: number, x1: number, y0: number, y1: number): number => {
        const c0 = Math.min(y0, this.viewBot);
        const c1 = Math.max(y1, this.viewTop);
        return Math.max((x1 - x0) / 2 + CAM_PAD, ((y1 - y0) / 2 + CAM_PAD) * aspect, ((c1 - c0) / 2) * aspect, band);
      };
      if (need(aMinX, aMaxX, aMinY, aMaxY) > maxW && nPlay > 0) {
        // Too spread out to show everybody: zoom out fully, keep every in-play fighter, and lean toward the fighters that
        // are flying off as far as that containment allows (so a launch toward a blast zone is followed).
        tw = maxW;
        const hh = tw / aspect;
        const cMinY = Math.min(pMinY, this.viewBot);
        const cMaxY = Math.max(pMaxY, this.viewTop);
        tx = rangeClamp((aMinX + aMaxX) / 2, pMaxX + CAM_PAD * 0.5 - tw, pMinX - CAM_PAD * 0.5 + tw, (pMinX + pMaxX) / 2);
        ty = rangeClamp(
          (Math.min(aMinY, this.viewBot) + Math.max(aMaxY, this.viewTop)) / 2,
          cMaxY + CAM_PAD * 0.5 - hh,
          cMinY - CAM_PAD * 0.5 + hh,
          (cMinY + cMaxY) / 2,
        );
      } else {
        tw = clamp(need(aMinX, aMaxX, aMinY, aMaxY), minW, maxW);
        const hh = tw / aspect;
        tx = (aMinX + aMaxX) / 2;
        // Vertical focus: centre of (fighters ∪ the stage band) so the slab and the highest platform stay on screen.
        ty = (Math.min(aMinY, this.viewBot) + Math.max(aMaxY, this.viewTop)) / 2;
        // Allowed focus range that keeps the (padded) fighter box inside the view.
        tx = rangeClamp(tx, aMaxX + CAM_PAD * 0.5 - tw, aMinX - CAM_PAD * 0.5 + tw, tx);
        ty = rangeClamp(ty, aMaxY + CAM_PAD * 0.5 - hh, aMinY - CAM_PAD * 0.5 + hh, ty);
      }
    }

    // KO pulse: zoom in a little and lean toward the KO position.
    if (this.koPulse > 0.001) {
      const k = this.koPulse * this.koPulse;
      tw = Math.max(minW * 0.9, tw * (1 - 0.1 * k));
      tx += clamp(this.koX - tx, -8, 8) * 0.14 * k;
      ty += clamp(this.koY - ty, -5, 5) * 0.1 * k;
      this.koPulse = Math.max(0, this.koPulse - d / 0.9);
    } else this.koPulse = 0;
    tx = clamp(tx, bl.left + tw * 0.5, bl.right - tw * 0.5);
    ty = clamp(ty, bl.bottom + tw / aspect * 0.5, bl.top - tw / aspect * 0.5);

    // Critically-damped follow (zooming out is quick so nobody leaves the view, zooming in is lazy).
    const zoomOut = tw > this.halfW;
    this.x = critDamp(this.x, this.vx, tx, 5.2, d);
    this.vx = spr.v;
    this.y = critDamp(this.y, this.vy, ty, 4.6, d);
    this.vy = spr.v;
    this.halfW = critDamp(this.halfW, this.vw, tw, zoomOut ? 8.5 : 3.0, d);
    this.vw = spr.v;
    this.halfW = clamp(this.halfW, minW * 0.9, maxW);

    // Hard containment: in-play fighters stay in view (the springs may lag a fast launch).
    if (nPlay > 0 || nAll > 0) this.contain(targets, count, nPlay > 0);

    // Shake decay (FX clock).
    this.trauma = Math.max(0, this.trauma - d * 1.7);
    this.apply();
  }

  /** The part of the playfield the camera promises to keep in view: around the platforms, not the far blast margins. */
  private isInPlay(t: CamTarget): boolean {
    return t.x > this.pfL && t.x < this.pfR && t.y > this.pfB && t.y < this.pfT;
  }

  private contain(targets: readonly CamTarget[], count: number, onlyPlay: boolean): void {
    const maxW = this.stage.camera.maxHalfW * Math.max(1, this.aspect / (16 / 9));
    for (let pass = 0; pass < 2; pass++) {
      const hh = this.halfW / this.aspect;
      for (let i = 0; i < count; i++) {
        const t = targets[i];
        if (!t.alive) continue;
        if (onlyPlay && !this.isInPlay(t)) continue;
        const mx = 1.2;
        const my0 = 0.7;
        const my1 = 2.2;
        // Horizontal: shift the focus first, then zoom out if the box is wider than the view.
        if (t.x - mx < this.x - this.halfW) this.x = t.x - mx + this.halfW;
        else if (t.x + mx > this.x + this.halfW) this.x = t.x + mx - this.halfW;
        if (t.y - my0 < this.y - hh) this.y = t.y - my0 + hh;
        else if (t.y + my1 > this.y + hh) this.y = t.y + my1 - hh;
      }
      // After shifting, a fighter on the opposite side may have been pushed out: zoom out to include everyone.
      let needW = this.halfW;
      for (let i = 0; i < count; i++) {
        const t = targets[i];
        if (!t.alive) continue;
        if (onlyPlay && !this.isInPlay(t)) continue;
        const dx = Math.abs(t.x - this.x) + 1.2;
        const dy = Math.max(Math.abs(t.y - this.y - 0.7) + 1.5, 0) * this.aspect;
        if (dx > needW) needW = dx;
        if (dy > needW) needW = dy;
      }
      if (needW > this.halfW) {
        this.halfW = Math.min(needW, maxW);
        this.vw = Math.max(this.vw, 0);
      } else break;
    }
  }

  /** Write the three.js camera (position, look-at, shake). */
  apply(): void {
    const w = this.halfW;
    const dist = w / (this.aspect * TAN_HALF_FOV);
    let sx = 0;
    let sy = 0;
    let roll = 0;
    const tr = this.trauma;
    if (tr > 0.001 && !this.reduceMotion) {
      const a = tr * tr * this.shakeScale;
      const t = this.time;
      const amp = 0.018 * w; // metres at the focus plane per unit trauma²
      sx = (Math.sin(t * 61.3) + Math.sin(t * 37.7 + 1.3) * 0.6) * amp * a;
      sy = (Math.sin(t * 53.1 + 2.1) + Math.sin(t * 29.9 + 0.4) * 0.6) * amp * a * 0.8;
      roll = Math.sin(t * 43.7 + 0.9) * 0.012 * a;
    }
    this.sx = this.x + sx;
    this.sy = this.y + sy;
    const cam = this.camera;
    cam.position.set(this.sx, this.sy + dist * SIN_PITCH, dist * COS_PITCH);
    cam.up.set(Math.sin(roll), Math.cos(roll), 0);
    cam.lookAt(this.sx, this.sy, 0);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
  }

  /** Distance from the camera to the z = 0 plane (m). */
  get distance(): number {
    return this.halfW / (this.aspect * TAN_HALF_FOV);
  }

  /** World → CSS pixels for a canvas of `w × h`. Uses the camera as last applied. */
  project(x: number, y: number, w: number, h: number, out: { x: number; y: number; onScreen: boolean }): void {
    _p.set(x, y, 0).project(this.camera);
    out.x = (_p.x * 0.5 + 0.5) * w;
    out.y = (-_p.y * 0.5 + 0.5) * h;
    out.onScreen = _p.z > -1 && _p.z < 1 && _p.x >= -1 && _p.x <= 1 && _p.y >= -1 && _p.y <= 1;
  }
}
