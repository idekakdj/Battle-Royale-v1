/**
 * READY-state ultimate targeting preview (v1.3 WP-T, plan §4).
 *
 * While the player's ultimate bar is full (and they are alive, in the match, not
 * mid-cast) this draws — from the ultimate's `targeting` config via
 * `previewUltTarget`, with the aim the sim would use (camera yaw / locked target):
 *   lock   → faint dashed range ring at the player + a gold LOCK reticle on the
 *            would-be target (dim red ring + no reticle when nothing is valid)
 *   line   → the path ribbon (start → end, real width)
 *   ground → range ring + the landing zone (radius from the config)
 * Ultimates without a `targeting` block (kind 'self') show nothing.
 *
 * The result (`status`, `targetId`) also drives the HUD: NO TARGET on the icon and
 * the DOM "LOCK" tag over the target. Markers use owner {@link PREVIEW_OWNER}
 * so the ult dispatcher's per-fighter cleanup never touches them.
 */

import type { FighterState } from '../../../core/types';
import { ANIMALS } from '../../../config/animals';
import type { ReticleHandle, RibbonHandle, RingHandle, UltIndicators, ZoneHandle } from '../primitives';
import { previewUltTarget, ultTargetingOf, type UltPreviewResult } from '../targetingBridge';

export const PREVIEW_OWNER = -2;
const RECOMPUTE_HZ = 30;
const RING_ALPHA = 0.5;
const FOLLOW_RATE = 18; // 1/s — reticle / zone glide toward the target

/** 'off' = nothing to preview (self ult / disabled), 'ok' = valid, 'none' = nothing valid to hit. */
export type PreviewStatus = 'off' | 'ok' | 'none';

export interface PreviewFrame {
  /** Setting on AND the player is in a state that may preview (ready, alive, in match, not casting). */
  enabled: boolean;
  player: FighterState;
  fighters: readonly FighterState[];
  /** World yaw the sim would aim with (locked target direction, else camera yaw). */
  aimYaw: number;
  /** Interpolated player position (where the ring is drawn). */
  px: number;
  py: number;
  pz: number;
}

export class UltPreview {
  status: PreviewStatus = 'off';
  /** Would-be target (lock kind), else -1. */
  targetId = -1;

  private readonly ind: UltIndicators;
  private ring: RingHandle | null = null;
  private ribbon: RibbonHandle | null = null;
  private reticle: ReticleHandle | null = null;
  private zone: ZoneHandle | null = null;
  private res: UltPreviewResult | null = null;
  private acc = 1;
  private lastValid = true;
  private lastKind = '';
  private rx = 0;
  private rz = 0;
  private hasR = false;
  private zx = 0;
  private zz = 0;
  private hasZ = false;

  constructor(indicators: UltIndicators) {
    this.ind = indicators;
  }

  /**
   * Per render frame. `targetPos(id, out)` writes the target's interpolated
   * ground position (x, z) into `out` (a 2-slot array).
   */
  update(dt: number, f: PreviewFrame, targetPos: (id: number, out: number[]) => void): void {
    const spec = ANIMALS[f.player.animal].ultimate;
    const cfg = ultTargetingOf(spec);
    if (!f.enabled || cfg === null) {
      this.hide();
      return;
    }

    this.acc += dt;
    if (this.res === null || this.acc >= 1 / RECOMPUTE_HZ) {
      this.acc = 0;
      this.res = previewUltTarget(spec, f.player, f.fighters, { aimYaw: f.aimYaw });
    }
    const res = this.res;
    const valid = res.valid;
    this.status = valid ? 'ok' : 'none';
    // Lock ults (and lock-assisted lines, e.g. the rhino) pin a LOCK bracket on the would-be victim.
    this.targetId = (res.kind === 'lock' || res.kind === 'line') && valid && res.targetId >= 0 ? res.targetId : -1;

    const style = valid ? 'friendly' : 'invalid';
    if (this.lastValid !== valid || this.lastKind !== res.kind) {
      this.lastValid = valid;
      this.lastKind = res.kind;
      this.ring?.setStyle(style);
      this.ribbon?.setStyle(style);
      this.zone?.setStyle(style);
    }

    // Range ring for lock / ground kinds.
    if (res.kind === 'lock' || res.kind === 'ground') {
      if (this.ring === null || !this.ring.held(PREVIEW_OWNER)) {
        this.ring = this.ind.ring(PREVIEW_OWNER);
        this.ring.show(f.px, f.py, f.pz, res.range, 0.09, style);
        this.ring.setDash(56, 0.15);
        this.ring.setFill(valid ? 0.05 : 0.03);
        this.ring.setAlpha(RING_ALPHA);
      }
      this.ring.update(f.px, f.py, f.pz, res.range, 0.09);
    } else {
      this.dropRing();
    }

    // Path ribbon for line kinds.
    if (res.kind === 'line') {
      const w = res.width > 0.2 ? res.width : 1.6;
      if (this.ribbon === null || !this.ribbon.held(PREVIEW_OWNER)) {
        this.ribbon = this.ind.ribbon(PREVIEW_OWNER);
        this.ribbon.show(f.px, f.py, f.pz, res.to.x, 0, res.to.z, w, style);
        this.ribbon.setAlpha(0.7);
        this.ribbon.setHead(1);
      }
      this.ribbon.update(f.px, f.py, f.pz, res.to.x, 0, res.to.z, w);
    } else {
      this.dropRibbon();
    }

    // Ground zone.
    if (res.kind === 'ground') {
      const zr = res.width > 0.2 ? res.width * 0.5 : 2.5;
      const k = 1 - Math.exp(-dt * FOLLOW_RATE);
      if (!this.hasZ) {
        this.zx = res.to.x;
        this.zz = res.to.z;
        this.hasZ = true;
      } else {
        this.zx += (res.to.x - this.zx) * k;
        this.zz += (res.to.z - this.zz) * k;
      }
      if (this.zone === null || !this.zone.held(PREVIEW_OWNER)) {
        this.zone = this.ind.zone(PREVIEW_OWNER);
        this.zone.show(this.zx, 0, this.zz, zr, style);
        this.zone.setAlpha(0.75);
      }
      this.zone.update(this.zx, 0, this.zz, zr);
    } else {
      this.dropZone();
    }

    // LOCK reticle on the would-be target.
    if (this.targetId >= 0) {
      const t = f.fighters[this.targetId];
      targetPos(this.targetId, _pos);
      const k = 1 - Math.exp(-dt * FOLLOW_RATE);
      if (!this.hasR) {
        this.rx = _pos[0];
        this.rz = _pos[1];
        this.hasR = true;
      } else {
        this.rx += (_pos[0] - this.rx) * k;
        this.rz += (_pos[1] - this.rz) * k;
      }
      const rr = Math.max(1.2, (t !== undefined ? ANIMALS[t.animal].radius : 0.8) + 0.65);
      if (this.reticle === null || !this.reticle.held(PREVIEW_OWNER)) {
        this.reticle = this.ind.reticle(PREVIEW_OWNER);
        this.reticle.show(this.rx, 0, this.rz, rr, 'lock');
      }
      this.reticle.update(this.rx, 0, this.rz, rr);
    } else {
      this.dropReticle();
    }
  }

  /** Hide every preview marker and reset the status (dead / spectating / paused / no ult). */
  hide(immediate = false): void {
    this.status = 'off';
    this.targetId = -1;
    this.res = null;
    this.dropRing(immediate);
    this.dropRibbon(immediate);
    this.dropZone(immediate);
    this.dropReticle(immediate);
  }

  private dropRing(immediate = false): void {
    if (this.ring !== null && this.ring.held(PREVIEW_OWNER)) this.ring.hide(immediate ? 0 : 0.18);
    this.ring = null;
  }

  private dropRibbon(immediate = false): void {
    if (this.ribbon !== null && this.ribbon.held(PREVIEW_OWNER)) this.ribbon.hide(immediate ? 0 : 0.18);
    this.ribbon = null;
  }

  private dropZone(immediate = false): void {
    if (this.zone !== null && this.zone.held(PREVIEW_OWNER)) this.zone.hide(immediate ? 0 : 0.18);
    this.zone = null;
    this.hasZ = false;
  }

  private dropReticle(immediate = false): void {
    if (this.reticle !== null && this.reticle.held(PREVIEW_OWNER)) this.reticle.hide(immediate ? 0 : 0.14);
    this.reticle = null;
    this.hasR = false;
  }
}

const _pos: number[] = [0, 0];
