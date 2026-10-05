/**
 * Mole burrow visuals (v1.6, WP-B2): what the player sees while a fighter is UNDERGROUND (`BrawlFighterState.underground`, a move
 * whose body has `burrow: {from, to}`). The rig itself is hidden by `BrawlRig` (`hiddenUnderground`); this class draws the rest:
 *
 *  - a DIRT MOUND (a low lumpy dome of soil + a trailing ridge, two tiny meshes) that grows as the mole sinks, travels with the
 *    fighter (position and platform height come from the interpolated fighter, so it rides moving platforms), and heaves up and
 *    collapses at the eruption;
 *  - pooled VFX through `Vfx`: a puff / clod burst at the dig-in point (≈ frame `from − 1.5`), soil kicked up every few frames while
 *    tunnelling, and the big earth burst (dirt fan up, ground ring, dust roll) on the first eruption frame (`to`).
 *
 * Everything is driven by the continuous move frame `moveFrame − (1 − alpha)` (pure function of the snapshot, like the pose), so it is
 * frame-rate independent; transitions are edge-detected per fighter (`phase`) and reset whenever the move is not a burrow.
 * Zero allocation per frame in steady state; `dispose` releases the geometry and materials.
 */

import * as THREE from 'three';
import { getMoveBody, getMoveset } from '../data';
import { MOVE_IDS, type BrawlFighterState, type MoveId } from '../types';
import type { Vfx } from './vfx/Vfx';

/** Does any ground move of `animal` have a burrow window? (The view only builds a `BurrowFx` for those.) */
export function animalHasBurrow(animal: BrawlFighterState['animal']): boolean {
  const set = getMoveset(animal);
  for (const id of MOVE_IDS) {
    const m = set.moves[id];
    if (m.ground.burrow !== undefined) return true;
  }
  return false;
}

const SOIL = 0x7a5836;
const SOIL_DARK = 0x5f4328;

/** How long (s) the eruption heave + collapse of the mound lasts. */
const ERUPT_S = 0.26;

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** A lumpy upper hemisphere (radius 0.5, base on y = 0): deterministic vertex noise so the soil heap is not a perfect dome. */
function lumpyDome(widthSegs: number, heightSegs: number, seed: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.5, widthSegs, heightSegs, 0, Math.PI * 2, 0, Math.PI / 2);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (y > 0.001) {
      const n = 1 + 0.13 * Math.sin(x * 11 + seed) * Math.cos(z * 9 - seed * 1.7) + 0.07 * Math.sin((x + z) * 19 + seed * 3);
      pos.setXYZ(i, x * n, y * n, z * n);
    }
  }
  g.computeVertexNormals();
  return g;
}

export class BurrowFx {
  /** The mound's root (tests / debug): positioned at the interpolated feet of the fighter while it is shown. */
  readonly group = new THREE.Group();
  private readonly head: THREE.Mesh;
  private readonly ridge: THREE.Mesh;
  private readonly geoHead: THREE.BufferGeometry;
  private readonly geoRidge: THREE.BufferGeometry;
  private readonly matHead: THREE.MeshStandardMaterial;
  private readonly matRidge: THREE.MeshStandardMaterial;

  /** Burrow window of the move currently being performed (null = not a burrow move). */
  private win: { from: number; to: number } | null = null;
  private keyId: MoveId | null = null;
  private keyAir = false;
  private keyChain = -1;
  /** 0 = nothing yet, 1 = dig-in burst done, 2 = eruption burst done (reset when the move ends). */
  private phase = 0;
  private k = 0; // mound presence 0..1 (smoothed)
  private erupt = ERUPT_S; // seconds since the eruption
  private accTrail = 0;
  private ridgeLen = 0;
  /** The continuous move frame of the previous update (a smaller one = a rollback / a new move: the phases are re-derived). */
  private lastF = 0;

  constructor(
    parent: THREE.Object3D,
    private readonly vfx: Vfx,
    private readonly w: number,
  ) {
    this.geoHead = lumpyDome(10, 5, 1.3);
    this.geoRidge = lumpyDome(8, 4, 4.1);
    this.matHead = new THREE.MeshStandardMaterial({ color: SOIL, roughness: 1, metalness: 0, flatShading: true });
    this.matRidge = new THREE.MeshStandardMaterial({ color: SOIL_DARK, roughness: 1, metalness: 0, flatShading: true });
    this.head = new THREE.Mesh(this.geoHead, this.matHead);
    this.ridge = new THREE.Mesh(this.geoRidge, this.matRidge);
    this.head.frustumCulled = false;
    this.ridge.frustumCulled = false;
    this.group.add(this.head, this.ridge);
    this.group.name = 'brawl-burrow-mound';
    // Visible (but scaled to nothing) until the first update, so the view's up-front shader compile includes these materials.
    this.head.scale.setScalar(0.0001);
    this.ridge.scale.setScalar(0.0001);
    parent.add(this.group);
  }

  /** True while the mound is on screen (tests / debug). */
  get shown(): boolean {
    return this.group.visible;
  }

  get phaseNow(): number {
    return this.phase;
  }

  /** The burrow window of the current move, resolved only when the move changes. */
  private resolve(cur: BrawlFighterState): void {
    if (cur.action !== 'attack' || cur.moveId === null) {
      this.win = null;
      this.keyId = null;
      return;
    }
    if (cur.moveId === this.keyId && cur.moveAir === this.keyAir && cur.moveChain === this.keyChain) return;
    this.keyId = cur.moveId;
    this.keyAir = cur.moveAir;
    this.keyChain = cur.moveChain;
    const b = getMoveBody(cur.animal, cur.moveId, cur.moveAir, cur.moveChain);
    this.win = !cur.moveAir && b.burrow !== undefined ? { from: b.burrow.from, to: b.burrow.to } : null;
  }

  /** Back to nothing (respawn, match restart, the fighter is gone). */
  reset(): void {
    this.win = null;
    this.keyId = null;
    this.phase = 0;
    this.k = 0;
    this.erupt = ERUPT_S;
    this.accTrail = 0;
    this.ridgeLen = 0;
    this.lastF = 0;
    this.group.visible = false;
  }

  /**
   * Advance one render frame. (`x`, `y`) = the interpolated feet position (so the mound follows the platform surface, moving
   * platforms included); `dt` = FX seconds; `time` = FX clock; [`px0`, `px1`] = the span of the platform the fighter stands on (the heap
   * is kept on it when the tunnel ends at an edge, so it never hangs in the air). Returns true on the frame the eruption bursts (the
   * view adds a rumble).
   */
  update(cur: BrawlFighterState, alpha: number, x: number, y: number, dt: number, time: number, px0 = -Infinity, px1 = Infinity): boolean {
    if (!cur.alive || cur.action === 'ko') {
      if (this.group.visible || this.phase !== 0) this.reset();
      return false;
    }
    this.resolve(cur);
    const win = this.win;
    if (win === null) {
      if (this.phase !== 0) this.phase = 0;
      if (this.k <= 0.001 && this.erupt >= ERUPT_S) {
        if (this.group.visible) this.group.visible = false;
        return false;
      }
    }
    const f = cur.hitlag > 0 ? cur.moveFrame : cur.moveFrame - (1 - alpha);
    const dir = cur.facing;
    let erupted = false;
    let target = 0;
    if (win !== null) {
      if (f < this.lastF - 0.5) {
        // time went backwards (a rollback, or the same move started again): re-derive the phases without spawning anything
        this.phase = f >= win.to ? 2 : f >= win.from - 1.5 ? 1 : 0;
        if (this.phase < 2) this.erupt = ERUPT_S;
      }
      if (this.phase < 1 && f >= win.from - 1.5 && f < win.to) {
        this.vfx.burrowDig(x + dir * 0.15, y, dir);
        this.phase = 1;
        this.accTrail = 0;
      }
      if (this.phase < 2 && f >= win.to) {
        if (this.phase < 1) this.vfx.burrowDig(x + dir * 0.15, y, dir); // (a long hitch skipped the dig-in)
        this.vfx.burrowErupt(x + dir * 0.35, y, dir, 1);
        this.phase = 2;
        this.erupt = 0;
        erupted = true;
      }
      if (f >= win.from - 2.2 && f < win.to) target = 1;
      this.lastF = f;
    } else this.lastF = 0;
    if (dt > 0) {
      this.k += (target - this.k) * (1 - Math.exp(-dt * (target > this.k ? 16 : 30)));
      if (target === 0 && this.k < 0.004) this.k = 0;
      if (this.erupt < ERUPT_S) this.erupt = Math.min(ERUPT_S, this.erupt + dt);
    } else if (target === 1) this.k = 1;

    // Soil kicked up from the travelling heap while the mole is under the floor.
    if (win !== null && target === 1 && f >= win.from + 0.3 && dt > 0) {
      this.accTrail += dt;
      const iv = 0.05 / Math.max(0.4, this.vfx.scale);
      while (this.accTrail >= iv) {
        this.accTrail -= iv;
        this.vfx.burrowTrail(x, y, dir);
      }
    }

    // Mound meshes.
    const swell = this.erupt < ERUPT_S ? (1 + 0.85 * smooth01(this.erupt / 0.07)) * (1 - smooth01((this.erupt - 0.07) / (ERUPT_S - 0.07))) : 1;
    const eruptShow = this.erupt < ERUPT_S;
    const s = eruptShow ? swell * Math.max(this.k, 0.35 * (1 - this.erupt / ERUPT_S)) : this.k;
    if (s <= 0.003) {
      if (this.group.visible) this.group.visible = false;
      return erupted;
    }
    this.group.visible = true;
    const bob = Math.sin(time * 46) * 0.018 * s;
    const sc = Math.max(0.5, this.w / 0.68);
    // keep the heap on the platform: at an edge it is nudged inward (never wider than the platform allows)
    let gx = x + dir * 0.04;
    const half = 0.47 * sc;
    if (px1 - px0 > half * 2) gx = gx < px0 + half ? px0 + half : gx > px1 - half ? px1 - half : gx;
    this.group.position.set(gx, y - 0.03, 0.04);
    const hw = 1.35 * sc * s;
    const hh = 0.78 * sc * s * (eruptShow ? 1.25 : 1) + bob;
    this.head.scale.set(hw, Math.max(0.001, hh), 0.95 * sc * s);
    this.head.rotation.z = Math.sin(time * 31) * 0.05;
    // The ridge trails behind: it lengthens while the tunnel runs and shortens as the mole stops / surfaces.
    // (the sim stops the tunnel at the platform edge with vx = 0: the heap then just churns in place, without the trailing ridge)
    const moving = win !== null && f >= win.from && f < win.to - 1 && Math.abs(cur.vel.x) > 1.5 ? 1 : 0;
    this.ridgeLen += ((moving > 0 ? 1.55 * sc : 0) - this.ridgeLen) * (1 - Math.exp(-dt * (moving > 0 ? 9 : 22)));
    const len = this.ridgeLen * this.k;
    if (len < 0.05) this.ridge.visible = false;
    else {
      this.ridge.visible = true;
      this.ridge.scale.set(len, 0.3 * sc * this.k, 0.7 * sc * this.k);
      this.ridge.position.set(-dir * (0.35 * sc + len * 0.5), 0, 0);
    }
    return erupted;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geoHead.dispose();
    this.geoRidge.dispose();
    this.matHead.dispose();
    this.matRidge.dispose();
  }
}
