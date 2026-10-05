/**
 * World-anchored combat overlay (WP-M, §6.2): projects fighters into screen
 * space and drives the pooled DOM widgets in `ui/Nameplates` and
 * `ui/ThreatIndicators`.
 *
 *  - Nameplates over every live enemy's head (animal name + thin HP bar +
 *    guard-break flash), faded/shrunk by camera distance, hidden when dead,
 *    hidden (stealth / burrowed), behind the camera or off screen.
 *  - Lock-on reticle over the locked target's body.
 *  - Edge arrows for enemies within 12 m that are mid-attack but off screen.
 *  - Damage-direction wedges when the player is hit (tracks the attacker live).
 *
 * All vectors are reused; per frame this is ~10 projections and a handful of
 * transform/opacity writes (diffed inside the widgets).
 */

import * as THREE from 'three';
import { wrapAngle } from '../core/math';
import type { AnimalId, FighterState, WorldSnapshot } from '../core/types';
import { MAX_PLATES, Nameplates } from '../ui/Nameplates';
import { MAX_THREATS, ThreatIndicators } from '../ui/ThreatIndicators';

const PLATE_FULL_DIST = 14; // m: fully opaque up to here
const PLATE_FADE_DIST = 30; // m: invisible beyond
const PLATE_HEAD_PAD = 0.55; // m above the head anchor
const THREAT_DIST = 12; // m
const NDC_MARGIN_X = 1.02;
const NDC_MARGIN_Y = 1.05;

const _v = new THREE.Vector3();

/** True while an enemy's swing / special / ultimate is in progress. */
function isAttacking(f: FighterState): boolean {
  const a = f.action;
  return a === 'attack1' || a === 'attack2' || a === 'attack3' || a === 'special' || a === 'ultimate';
}

/** Stealthed or underground fighters get no plate / arrow / lock. */
export function isHidden(f: FighterState): boolean {
  if (f.action === 'burrowed') return true;
  const b = f.buffs;
  for (let i = 0; i < b.length; i++) if (b[i].kind === 'stealth') return true;
  return false;
}

export class CombatOverlay {
  private readonly plates = new Nameplates();
  private readonly threats = new ThreatIndicators();
  /** fighter id → plate slot (-1 for the player). */
  private slotOf: number[] = [];
  private positions: readonly THREE.Vector3[] = [];
  private heights: readonly number[] = [];
  private playerId = 0;
  private camYaw = 0;
  private mounted = false;
  private readonly angleOf = (attackerId: number): number => this.screenAngleTo(attackerId);

  /**
   * @param positions live (interpolated) root position per fighter id
   *                  (the rigs' `root.position` vectors; read, never written)
   * @param heights   head-anchor height per fighter id (m above the feet)
   * @param names     v1.5 online: chosen player names per fighter id (`null` = show the animal name)
   */
  mount(
    layer: HTMLElement,
    animals: readonly AnimalId[],
    positions: readonly THREE.Vector3[],
    heights: readonly number[],
    playerId: number,
    names?: readonly (string | null)[],
  ): void {
    this.plates.mount(layer);
    this.threats.mount(layer);
    this.positions = positions;
    this.heights = heights;
    this.playerId = playerId;
    this.slotOf = [];
    let slot = 0;
    for (let id = 0; id < animals.length; id++) {
      if (id === playerId || slot >= MAX_PLATES) {
        this.slotOf.push(-1);
        continue;
      }
      this.plates.setAnimal(slot, animals[id]);
      const name = names?.[id];
      if (name !== undefined && name !== null) this.plates.setName(slot, name);
      this.slotOf.push(slot++);
    }
    this.mounted = true;
  }

  unmount(): void {
    this.plates.unmount();
    this.threats.unmount();
    this.mounted = false;
  }

  onGuardBreak(targetId: number, nowMs: number): void {
    const slot = this.slotOf[targetId] ?? -1;
    if (slot >= 0) this.plates.flashGuardBreak(slot, nowMs);
  }

  /** The player took a hit from `attackerId` (ignored for self/environment). */
  onPlayerHit(attackerId: number, nowMs: number): void {
    if (!this.mounted || attackerId < 0 || attackerId === this.playerId) return;
    this.threats.hurt(attackerId, this.screenAngleTo(attackerId), nowMs);
  }

  /**
   * Per render frame, after the scene has rendered (camera matrices current).
   * @param viewerId fighter the camera follows (no plate drawn over it)
   * @param lockId   locked target id or -1
   * @param playerAlive false in spectate: no threat arrows / wedges
   */
  update(
    snap: WorldSnapshot,
    camera: THREE.PerspectiveCamera,
    camYaw: number,
    viewW: number,
    viewH: number,
    viewerId: number,
    lockId: number,
    playerAlive: boolean,
    nowMs: number,
  ): void {
    if (!this.mounted) return;
    this.camYaw = camYaw;
    this.threats.setViewport(viewW, viewH);
    const fighters = snap.fighters;
    const player = fighters[this.playerId];
    const pp = this.positions[this.playerId];
    const camPos = camera.position;
    let arrowSlot = 0;
    let reticleShown = false;

    for (let id = 0; id < fighters.length; id++) {
      const slot = this.slotOf[id] ?? -1;
      if (slot < 0) continue;
      const f = fighters[id];
      const p = this.positions[id];
      if (p === undefined) continue;
      const hidden = !f.alive || isHidden(f);
      const h = this.heights[id] ?? 1.5;

      // Nameplate.
      let onScreen = false;
      if (!hidden && id !== viewerId) {
        _v.set(p.x, p.y + h + PLATE_HEAD_PAD, p.z);
        const dist = _v.distanceTo(camPos);
        _v.project(camera);
        onScreen = _v.z < 1 && Math.abs(_v.x) <= NDC_MARGIN_X && Math.abs(_v.y) <= NDC_MARGIN_Y;
        if (onScreen && dist < PLATE_FADE_DIST) {
          const sx = (_v.x * 0.5 + 0.5) * viewW;
          const sy = (-_v.y * 0.5 + 0.5) * viewH;
          const fade = dist <= PLATE_FULL_DIST ? 1 : 1 - (dist - PLATE_FULL_DIST) / (PLATE_FADE_DIST - PLATE_FULL_DIST);
          const scale = 1 - 0.3 * Math.min(1, Math.max(0, (dist - 5) / 25));
          const hpFrac = f.maxHp > 0 ? Math.max(0, Math.min(1, f.hp / f.maxHp)) : 0;
          this.plates.place(slot, sx, sy, scale, fade, hpFrac, id === lockId, nowMs);
        } else {
          this.plates.hide(slot);
        }
      } else {
        this.plates.hide(slot);
      }

      // Lock-on reticle at mid-body.
      if (id === lockId && !hidden) {
        _v.set(p.x, p.y + h * 0.6, p.z);
        const dist = _v.distanceTo(camPos);
        _v.project(camera);
        if (_v.z < 1 && Math.abs(_v.x) <= 1.1 && Math.abs(_v.y) <= 1.1) {
          const sx = (_v.x * 0.5 + 0.5) * viewW;
          const sy = (-_v.y * 0.5 + 0.5) * viewH;
          this.plates.placeReticle(sx, sy, Math.max(0.55, Math.min(1.2, 9 / Math.max(1, dist))));
          reticleShown = true;
        }
      }

      // Off-screen threat arrows (player perspective only).
      if (playerAlive && pp !== undefined && !hidden && isAttacking(f) && arrowSlot < MAX_THREATS) {
        const dx = p.x - pp.x;
        const dz = p.z - pp.z;
        if (dx * dx + dz * dz <= THREAT_DIST * THREAT_DIST) {
          // Off screen = not inside the viewport at body height.
          _v.set(p.x, p.y + h * 0.5, p.z).project(camera);
          const visible = _v.z < 1 && Math.abs(_v.x) <= 0.92 && Math.abs(_v.y) <= 0.92;
          if (!visible) this.threats.placeArrow(arrowSlot++, this.screenAngleTo(id));
        }
      }
    }

    if (!reticleShown) this.plates.hideReticle();
    for (let s = arrowSlot; s < MAX_THREATS; s++) this.threats.hideArrow(s);
    if (playerAlive && player !== undefined) this.threats.updateWedges(nowMs, this.angleOf);
    else this.threats.clearWedges();
  }

  /**
   * Screen angle (radians, clockwise from screen-up) from the player toward a
   * fighter, relative to the camera yaw. Yaw decreases when turning right, so
   * the screen angle is the negated relative yaw.
   */
  private screenAngleTo(id: number): number {
    const pp = this.positions[this.playerId];
    const p = this.positions[id];
    if (pp === undefined || p === undefined) return NaN;
    const dx = p.x - pp.x;
    const dz = p.z - pp.z;
    if (dx * dx + dz * dz < 1e-6) return NaN;
    return -wrapAngle(Math.atan2(dx, dz) - this.camYaw);
  }
}
