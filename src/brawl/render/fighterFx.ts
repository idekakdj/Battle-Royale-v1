/**
 * Per-fighter continuous effects: percent-reactive rim glow / steam / embers (≥ 100 / ≥ 150 %), invulnerability and
 * respawn feedback (pulse, laurel ring, hover pad), dodge afterimages, launch trail + speed lines (> 25 m/s), tumble
 * dust, run dust, hit / armor flashes. Tints the rig through (cloned, per-fighter) material emissive so fighters never
 * bleed into each other. Zero allocation per frame.
 */

import * as THREE from 'three';
import { ANIMALS } from '../../config/animals';
import type { BrawlFighterState } from '../types';
import type { BrawlRig } from './pose';
import { Vfx } from './vfx/Vfx';
import { softDiscTexture } from './stages/common';

function hexNum(s: string): number {
  return parseInt(s.replace('#', ''), 16) >>> 0;
}

export function accentOf(animal: BrawlFighterState['animal']): number {
  return hexNum(ANIMALS[animal].accent);
}

type Tintable = THREE.Material & { emissive: THREE.Color; emissiveIntensity: number };

function isTintable(m: THREE.Material): m is Tintable {
  const mm = m as Partial<Tintable>;
  return mm.emissive instanceof THREE.Color && typeof mm.emissiveIntensity === 'number';
}

export class FighterFx {
  readonly accent: number;
  private readonly tint: Tintable[] = [];
  private readonly owned: THREE.Material[] = [];
  private readonly pad: THREE.Group;
  private readonly padMat: THREE.MeshStandardMaterial;
  private readonly padGeo: THREE.BufferGeometry;
  private readonly padGlowMat: THREE.MeshBasicMaterial;
  private readonly padGlowGeo: THREE.BufferGeometry;
  private readonly padGlowTex: THREE.Texture;
  private hitFlash = 0;
  private armorFlash = 0;
  private accGhost = 0;
  private accDust = 0;
  private accTumble = 0;
  private accSteam = 0;
  private accEmber = 0;
  private accTrail = 0;
  private lastAction = '';
  private lastAlive = true;
  /** Set by the view when this fighter is on the respawn pad (so the pad follows the stage's respawn point). */
  padX = 0;
  padY = 12;

  constructor(
    rig: BrawlRig,
    animal: BrawlFighterState['animal'],
    private readonly vfx: Vfx,
    parent: THREE.Object3D,
    readonly w: number,
    readonly h: number,
  ) {
    this.accent = accentOf(animal);
    rig.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material;
      if (Array.isArray(m)) return;
      if (!isTintable(m) || m.side === THREE.BackSide || !m.colorWrite) return;
      const c = m.clone() as Tintable;
      mesh.material = c;
      this.owned.push(c);
      this.tint.push(c);
    });
    this.pad = new THREE.Group();
    this.padGeo = new THREE.BoxGeometry(2.9, 0.18, 1.7);
    this.padMat = new THREE.MeshStandardMaterial({ color: 0xf3dfb0, emissive: new THREE.Color(1.0, 0.72, 0.25), emissiveIntensity: 0.9, roughness: 0.5, metalness: 0.3 });
    const body = new THREE.Mesh(this.padGeo, this.padMat);
    this.padGlowGeo = new THREE.PlaneGeometry(5.2, 1.8);
    this.padGlowTex = softDiscTexture(64, 1.4);
    this.padGlowMat = new THREE.MeshBasicMaterial({ map: this.padGlowTex, color: new THREE.Color(1.0, 0.7, 0.25).multiplyScalar(1.3), transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const glow = new THREE.Mesh(this.padGlowGeo, this.padGlowMat);
    glow.position.set(0, -0.35, 0.9);
    this.pad.add(body, glow);
    this.pad.visible = false;
    parent.add(this.pad);
  }

  /** The target was hit (white flash) / absorbed a hit with armor (gold flash). */
  onHit(): void {
    this.hitFlash = 1;
  }
  onArmor(): void {
    this.armorFlash = 1;
  }

  /** Reset transient state (respawn / match restart). */
  reset(): void {
    this.hitFlash = this.armorFlash = 0;
    this.lastAction = '';
  }

  update(cur: BrawlFighterState, x: number, y: number, dt: number, time: number): void {
    const v = this.vfx;
    if (!cur.alive) {
      this.pad.visible = false;
      this.setEmissive(0, 0, 0);
      this.lastAlive = false;
      return;
    }
    if (!this.lastAlive) {
      this.lastAlive = true;
      this.reset();
    }
    this.hitFlash = Math.max(0, this.hitFlash - dt * 7);
    this.armorFlash = Math.max(0, this.armorFlash - dt * 3.6);
    const p = cur.percent;
    const act = cur.action;
    const speed = Math.hypot(cur.vel.x, cur.vel.y);
    const cx = x;
    const cy = y + this.h * 0.5;

    // ── emissive tint: percent rim, invulnerability pulse, flashes ──
    const rim = p < 90 ? 0 : Math.min(1, (p - 90) / 170);
    const pulse = 0.82 + 0.18 * Math.sin(time * 7 + cur.id);
    let er = 0.7 * rim * pulse;
    let eg = 0.07 * rim * pulse;
    let eb = 0.04 * rim * pulse;
    const dodging = act === 'dodgeSpot' || act === 'dodgeRoll' || act === 'dodgeAir';
    if (cur.invuln > 0) {
      const k = dodging ? 0.18 : 0.3 + 0.2 * Math.sin(time * 26);
      er += 0.5 * k;
      eg += 0.46 * k;
      eb += 0.2 * k;
    }
    if (this.hitFlash > 0) {
      er += 0.9 * this.hitFlash;
      eg += 0.85 * this.hitFlash;
      eb += 0.8 * this.hitFlash;
    }
    if (this.armorFlash > 0) {
      er += 1.0 * this.armorFlash;
      eg += 0.72 * this.armorFlash;
      eb += 0.18 * this.armorFlash;
    }
    this.setEmissive(er, eg, eb);

    // ── respawn: hover pad + laurel ring ──
    if (act === 'respawn') {
      this.pad.visible = true;
      this.pad.position.set(this.padX, this.padY - 0.09, 0);
      this.padMat.emissiveIntensity = 0.7 + 0.3 * Math.sin(time * 6);
      v.trackLaurel(cx, cy, Math.max(this.w, this.h) * 0.85 + 0.45 + 0.05 * Math.sin(time * 5), dt, 0xffd86a, time);
      v.trackGlow(cx, y + 0.05, 2.6, dt, 0xffc35a, 1.0, 0.22);
      if (this.lastAction !== 'respawn') v.respawnBurst(cx, cy);
    } else {
      this.pad.visible = false;
    }
    this.lastAction = act;

    // ── dodge afterimages ──
    if (dodging) {
      this.accGhost += dt;
      while (this.accGhost >= 0.034) {
        this.accGhost -= 0.034;
        v.ghost(cx, y, this.w, this.h, this.accent, 0.5);
      }
    } else this.accGhost = 0;

    // ── launch trail + speed lines (> 25 m/s) ──
    const launched = (act === 'hitstun' || act === 'tumble') && cur.hitlag <= 0;
    if (launched && speed > 25) {
      const ang = Math.atan2(cur.vel.y, cur.vel.x);
      const k = Math.min(1.5, speed / 36);
      this.accTrail += dt;
      while (this.accTrail >= 0.016) {
        this.accTrail -= 0.016;
        const len = 2.2 + speed * 0.07;
        v.streak(cx - Math.cos(ang) * len * 0.45, cy - Math.sin(ang) * len * 0.45, ang, 0, len, len * 0.8, 0.5 * k, 0.16, 0xffe2b0, 2.6, 0.9, 0);
        v.glow(cx, cy, 1.4 * k, 0.5, 0.22, 0xff9a40, 2.2, 0.55);
      }
      const nl = v.rng.next() < 0.6 * v.scale ? 1 : 0;
      for (let i = 0; i < nl; i++) {
        const along = v.rng.signed() * 5;
        const perp = v.rng.signed() * 5.5;
        v.speedLine(cx + Math.cos(ang) * along - Math.sin(ang) * perp, cy + Math.sin(ang) * along + Math.cos(ang) * perp, ang, 5 + speed * 0.14);
      }
    } else this.accTrail = 0;

    // ── tumble dust ──
    if ((act === 'tumble' || (act === 'hitstun' && speed > 14)) && cur.hitlag <= 0 && speed > 9) {
      this.accTumble += dt;
      const iv = 0.07 / Math.max(0.5, v.scale);
      while (this.accTumble >= iv) {
        this.accTumble -= iv;
        v.tumbleDust(cx, cy, speed);
      }
    } else this.accTumble = 0;

    // ── run dust ──
    if (cur.grounded && act === 'run' && Math.abs(cur.vel.x) > 4) {
      this.accDust += dt;
      const iv = 0.13 / Math.max(0.5, v.scale);
      while (this.accDust >= iv) {
        this.accDust -= iv;
        v.runDust(cx, y, cur.vel.x > 0 ? 1 : -1);
      }
    } else this.accDust = 0;

    // ── percent: steam at ≥ 100, embers at ≥ 150 ──
    if (p >= 100) {
      const sev = Math.min(1, (p - 100) / 150);
      this.accSteam += dt * (3 + sev * 9) * v.scale;
      while (this.accSteam >= 1) {
        this.accSteam -= 1;
        v.steam(cx, y + this.h * (0.75 + 0.25 * v.rng.next()), sev);
      }
    } else this.accSteam = 0;
    if (p >= 150) {
      const sev = Math.min(1, (p - 150) / 150);
      this.accEmber += dt * (6 + sev * 12) * v.scale;
      while (this.accEmber >= 1) {
        this.accEmber -= 1;
        v.ember(cx, y + this.h * (0.3 + 0.7 * v.rng.next()));
      }
    } else this.accEmber = 0;
  }

  private setEmissive(r: number, g: number, b: number): void {
    const t = this.tint;
    for (let i = 0; i < t.length; i++) {
      t[i].emissive.setRGB(Math.min(1.6, r), Math.min(1.6, g), Math.min(1.6, b));
      t[i].emissiveIntensity = 1;
    }
  }

  dispose(): void {
    for (const m of this.owned) m.dispose();
    this.owned.length = 0;
    this.tint.length = 0;
    this.padGeo.dispose();
    this.padMat.dispose();
    this.padGlowGeo.dispose();
    this.padGlowMat.dispose();
    this.padGlowTex.dispose();
    this.pad.removeFromParent();
  }
}
