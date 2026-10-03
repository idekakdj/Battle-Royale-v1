/**
 * Champions League VFX hub: two pooled quad systems (additive + alpha, one draw call each) and the high-level
 * emitters (hit sparks along the launch angle, rings, dust, KO blast, laurel, ghosts, streaks …). All positions are
 * stage space (x right, y up); effects sit slightly in front of the fighter plane (z = 0.6) so they read over the bodies.
 * Zero allocation per frame in steady state (a scratch `Spec` is reused everywhere).
 */

import * as THREE from 'three';
import { K, QuadPool, Spec } from './QuadPool';

const DEG = Math.PI / 180;

/** xorshift32 — cosmetic randomness (reproducible in screenshots; NOT the sim rng). */
export class FxRng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  signed(): number {
    return this.next() * 2 - 1;
  }
}

export class Vfx {
  readonly root = new THREE.Group();
  readonly add: QuadPool;
  readonly alpha: QuadPool;
  readonly rng = new FxRng();
  /** Cosmetic spawn-count multiplier (tier fxScale). */
  scale = 1;
  /** Screen flash request (0..1) read and decayed by the view. */
  flash = 0;
  flashR = 1;
  flashG = 0.93;
  flashB = 0.8;
  private readonly S = new Spec();

  constructor(addCap = 760, alphaCap = 340) {
    this.add = new QuadPool(addCap, true);
    this.alpha = new QuadPool(alphaCap, false);
    this.root.name = 'brawl-vfx';
    this.root.add(this.alpha.mesh, this.add.mesh);
  }

  update(dt: number): void {
    this.add.update(dt);
    this.alpha.update(dt);
  }

  clear(): void {
    this.add.clear();
    this.alpha.clear();
    this.flash = 0;
  }

  get live(): number {
    return this.add.n + this.alpha.n;
  }

  dispose(): void {
    this.add.dispose();
    this.alpha.dispose();
    this.root.removeFromParent();
  }

  private n(count: number): number {
    const v = count * this.scale;
    const f = Math.floor(v);
    return f + (this.rng.next() < v - f ? 1 : 0);
  }

  // ── low-level helpers ──────────────────────────────────────────────────────

  /** Additive soft glow disc. */
  glow(x: number, y: number, size0: number, size1: number, life: number, hex: number, boost: number, a0 = 1, z = 0.62): void {
    const s = this.S.reset();
    s.kind = K.disc;
    s.x = x;
    s.y = y;
    s.z = z;
    s.sx0 = s.sy0 = size0;
    s.sx1 = s.sy1 = size1;
    s.life = life;
    s.rgb(hex, boost);
    s.a0 = a0;
    s.a1 = 0;
    s.ease = 0.5;
    this.add.spawn(s);
  }

  /** Additive ring (camera-facing ellipse: `squash` < 1 flattens it into a ground ripple). */
  ring(x: number, y: number, r0: number, r1: number, life: number, hex: number, boost: number, thick = 0.14, squash = 1, a0 = 1, z = 0.62): void {
    const s = this.S.reset();
    s.kind = K.ring;
    s.x = x;
    s.y = y;
    s.z = z;
    s.sx0 = r0 * 2;
    s.sy0 = r0 * 2 * squash;
    s.sx1 = r1 * 2;
    s.sy1 = r1 * 2 * squash;
    s.life = life;
    s.param = thick;
    s.rgb(hex, boost);
    s.a0 = a0;
    s.a1 = 0;
    s.ease = 0.45;
    this.add.spawn(s);
  }

  star(x: number, y: number, size0: number, size1: number, life: number, hex: number, boost: number, rot = 0): void {
    const s = this.S.reset();
    s.kind = K.star;
    s.x = x;
    s.y = y;
    s.z = 0.7;
    s.rot = rot;
    s.sx0 = s.sy0 = size0;
    s.sx1 = s.sy1 = size1;
    s.life = life;
    s.rgb(hex, boost);
    s.a0 = 1;
    s.a1 = 0;
    s.ease = 0.4;
    this.add.spawn(s);
  }

  /** Streak: head at the +x end after rotating by `angle` (radians), moving along it at `speed`. */
  streak(x: number, y: number, angle: number, speed: number, len0: number, len1: number, width: number, life: number, hex: number, boost: number, a0 = 1, drag = 4): void {
    const s = this.S.reset();
    s.kind = K.streak;
    s.x = x;
    s.y = y;
    s.z = 0.64;
    s.rot = angle;
    s.vx = Math.cos(angle) * speed;
    s.vy = Math.sin(angle) * speed;
    s.sx0 = len0;
    s.sy0 = width;
    s.sx1 = len1;
    s.sy1 = width * 0.35;
    s.life = life;
    s.rgb(hex, boost);
    s.a0 = a0;
    s.a1 = 0;
    s.drag = drag;
    s.ease = 0.7;
    this.add.spawn(s);
  }

  /** Small bright spark (a soft disc that falls under gravity). */
  spark(x: number, y: number, vx: number, vy: number, size: number, life: number, hex: number, boost: number, grav = 14): void {
    const s = this.S.reset();
    s.kind = K.disc;
    s.x = x;
    s.y = y;
    s.z = 0.66;
    s.vx = vx;
    s.vy = vy;
    s.sx0 = s.sy0 = size;
    s.sx1 = s.sy1 = size * 0.3;
    s.life = life;
    s.rgb(hex, boost);
    s.a0 = 1;
    s.a1 = 0;
    s.grav = grav;
    s.drag = 1.2;
    s.ease = 1;
    this.add.spawn(s);
  }

  /** Alpha-blended dust/steam puff. */
  puff(x: number, y: number, vx: number, vy: number, size0: number, size1: number, life: number, hex: number, alpha: number, grav = 0, z = 0.55): void {
    const s = this.S.reset();
    s.kind = K.puff;
    s.x = x;
    s.y = y;
    s.z = z;
    s.vx = vx;
    s.vy = vy;
    s.rot = this.rng.next() * 6.28;
    s.sx0 = s.sy0 = size0;
    s.sx1 = s.sy1 = size1;
    s.life = life;
    s.param = this.rng.next();
    s.rgb(hex, 1);
    s.a0 = alpha;
    s.a1 = 0;
    s.drag = 3;
    s.grav = grav;
    s.fadeIn = 0.15;
    s.ease = 0.55;
    this.alpha.spawn(s);
  }

  // ── high-level emitters ────────────────────────────────────────────────────

  /** Impact: star flash + core glow + radial burst lines + a push along the launch angle. `damage` sizes it; sweetspot = golden/bigger. */
  hit(x: number, y: number, angleDeg: number, damage: number, sweet: boolean, kbSpeed: number, tint: number): void {
    const ang = angleDeg * DEG;
    const big = Math.min(2.2, 0.8 + damage * 0.05 + (sweet ? 0.45 : 0) + Math.max(0, kbSpeed - 20) * 0.006);
    const hot = sweet ? 0xffd86a : 0xfff1d0;
    const edge = sweet ? 0xffa21f : tint;
    this.star(x, y, big * 0.7, big * 2.1, 0.17, hot, sweet ? 4.4 : 3.4, ang + Math.PI / 4);
    this.star(x, y, big * 0.45, big * 1.5, 0.14, 0xffffff, 3.2, ang);
    this.glow(x, y, big * 0.7, big * 1.9, 0.2, edge, sweet ? 2.8 : 2.0, 0.85);
    this.ring(x, y, big * 0.15, big * (sweet ? 1.25 : 0.95), 0.2, hot, 2.0, 0.07, 1, 0.55);
    // Radial burst: evenly spread lines (long / short alternating), pushed outward and fading fast.
    const k = Math.max(5, Math.round((7 + damage * 0.35 + (sweet ? 3 : 0)) * Math.min(1, 0.5 + this.scale * 0.5)));
    const off = this.rng.next() * 6.28;
    for (let i = 0; i < k; i++) {
      const a = off + (i / k) * 6.2832 + this.rng.signed() * 0.12;
      const long = i % 2 === 0;
      const len = big * (long ? this.rng.range(1.5, 2.5) : this.rng.range(0.8, 1.3));
      this.streak(x + Math.cos(a) * big * 0.35, y + Math.sin(a) * big * 0.35, a, big * (long ? 11 : 7), len * 0.7, len, big * (long ? 0.15 : 0.1), long ? 0.2 : 0.15, long ? hot : edge, 2.8, 1, 3.5);
    }
    if (kbSpeed > 12) {
      // Directional push along the launch.
      this.streak(x, y, ang, 5, big * 2.2, big * 4.4, 0.42 * big, 0.18, 0xffffff, 3.4, 1, 3);
      this.streak(x, y, ang + 0.28, 6, big * 1.6, big * 3.0, 0.2 * big, 0.16, edge, 2.6, 0.9, 3);
      this.streak(x, y, ang - 0.28, 6, big * 1.6, big * 3.0, 0.2 * big, 0.16, edge, 2.6, 0.9, 3);
    }
    const sp = this.n(2 + damage * 0.2);
    for (let i = 0; i < sp; i++) {
      const a = ang + this.rng.signed() * 1.1;
      const v = this.rng.range(4, 12);
      this.spark(x, y, Math.cos(a) * v, Math.sin(a) * v + 2, this.rng.range(0.1, 0.2), this.rng.range(0.3, 0.55), edge, 3);
    }
  }

  /** Armor absorbed a hit: gold flash + shield-like ring, no launch. */
  armor(x: number, y: number, damage: number): void {
    const big = 0.9 + Math.min(1.0, damage * 0.04);
    this.star(x, y, big * 0.4, big * 1.2, 0.16, 0xffd24a, 3.6, 0.3);
    this.ring(x, y, big * 0.3, big * 1.3, 0.3, 0xffc43a, 2.6, 0.2, 1, 1);
    this.glow(x, y, big * 0.9, big * 2.0, 0.26, 0xffb21f, 2.0, 0.8);
    const n = this.n(7);
    for (let i = 0; i < n; i++) {
      const a = this.rng.next() * 6.28;
      this.streak(x, y, a, this.rng.range(8, 15), 0.9 * big, 0.4 * big, 0.1, 0.22, 0xffcf55, 2.8, 1, 5);
    }
  }

  /** Ground/air jump rings. */
  jump(x: number, y: number, air: boolean, h: number): void {
    if (air) {
      this.ring(x, y + h * 0.3, 0.3, 1.8, 0.34, 0xbfe4ff, 2.2, 0.16, 0.42, 0.95);
      this.ring(x, y + h * 0.3, 0.2, 1.2, 0.26, 0xffffff, 2.0, 0.1, 0.42, 0.8);
      const n = this.n(5);
      for (let i = 0; i < n; i++) {
        this.spark(x + this.rng.signed() * 0.6, y + h * 0.3, this.rng.signed() * 3.5, -this.rng.range(2, 6), 0.12, 0.3, 0xcfeaff, 2.6, 2);
      }
    } else {
      this.ring(x, y + 0.04, 0.2, 1.4, 0.3, 0xf2e2c0, 1.0, 0.2, 0.28, 0.9);
      const n = this.n(4);
      for (let i = 0; i < n; i++) {
        const s = i % 2 === 0 ? 1 : -1;
        this.puff(x + s * 0.2, y + 0.12, s * this.rng.range(1.5, 3.5), this.rng.range(0.4, 1.2), 0.3, 0.8, 0.4, 0xd9c7a2, 0.55);
      }
    }
  }

  land(x: number, y: number, hard: boolean): void {
    const n = this.n(hard ? 8 : 4);
    for (let i = 0; i < n; i++) {
      const s = i % 2 === 0 ? 1 : -1;
      this.puff(x + s * this.rng.range(0.1, 0.5), y + 0.12, s * this.rng.range(2, hard ? 6 : 3.5), this.rng.range(0.3, 1.4), 0.35, hard ? 1.25 : 0.9, hard ? 0.55 : 0.4, 0xdcc8a0, hard ? 0.65 : 0.5);
    }
    if (hard) this.ring(x, y + 0.04, 0.3, 2.6, 0.28, 0xfff0d0, 1.4, 0.18, 0.2, 0.8);
  }

  runDust(x: number, y: number, dir: number): void {
    this.puff(x - dir * 0.35, y + 0.1, -dir * this.rng.range(0.4, 1.4), this.rng.range(0.2, 0.8), 0.22, 0.65, 0.34, 0xd7c29a, 0.45);
  }

  tumbleDust(x: number, y: number, speed: number): void {
    const s = Math.min(1.4, 0.4 + speed * 0.03);
    this.puff(x + this.rng.signed() * 0.25, y + this.rng.signed() * 0.25, this.rng.signed() * 1.2, this.rng.signed() * 1.2, s * 0.5, s * 1.3, 0.4, 0xcdb590, 0.4, 0, 0.5);
  }

  ledgeGrab(x: number, y: number): void {
    this.star(x, y, 0.4, 1.7, 0.22, 0xffe08a, 3.4, 0.4);
    this.ring(x, y, 0.2, 1.3, 0.3, 0xffd36a, 2.4, 0.18, 1, 0.9);
    const n = this.n(5);
    for (let i = 0; i < n; i++) this.spark(x, y, this.rng.signed() * 4, this.rng.range(1, 5), 0.13, 0.35, 0xffd36a, 2.8, 8);
  }

  /** Dodge afterimage: a soft ghost silhouette of the given size at the fighter's position. */
  ghost(x: number, y: number, w: number, h: number, hex: number, alpha = 0.5): void {
    const s = this.S.reset();
    s.kind = K.ghost;
    s.x = x;
    s.y = y + h * 0.5;
    s.z = 0.2;
    s.sx0 = w * 1.15;
    s.sy0 = h * 1.1;
    s.sx1 = w * 0.9;
    s.sy1 = h * 1.0;
    s.life = 0.26;
    s.rgb(hex, 1.9);
    s.a0 = alpha;
    s.a1 = 0;
    s.ease = 1;
    s.fadeIn = 0.1;
    this.add.spawn(s);
  }

  /**
   * A continuous glow tracking a moving point: call once per frame with the frame `dt`; lifetime-compensated so the
   * brightness is frame-rate independent (a ring/laurel that stays attached to the fighter).
   */
  trackLaurel(x: number, y: number, r: number, dt: number, hex: number, pulse: number): void {
    const life = 0.05;
    const s = this.S.reset();
    s.kind = K.laurel;
    s.x = x;
    s.y = y;
    s.z = 0.45;
    s.rot = pulse * 0.4;
    s.sx0 = s.sy0 = r * 2;
    s.sx1 = s.sy1 = r * 2;
    s.life = life;
    s.rgb(hex, 1.7);
    s.a0 = Math.min(1, (0.9 * dt) / (life * 0.5)) * 0.5;
    s.a1 = s.a0;
    s.fadeIn = 0;
    s.ease = 1;
    this.add.spawn(s);
  }

  /** One frame of a soft glow that follows a point (lifetime-compensated, like `trackLaurel`). */
  trackGlow(x: number, y: number, size: number, dt: number, hex: number, boost: number, strength: number): void {
    const life = 0.05;
    const s = this.S.reset();
    s.kind = K.disc;
    s.x = x;
    s.y = y;
    s.z = 0.3;
    s.sx0 = s.sy0 = size;
    s.sx1 = s.sy1 = size;
    s.life = life;
    s.rgb(hex, boost);
    s.a0 = Math.min(1, (strength * dt) / (life * 0.5));
    s.a1 = s.a0;
    s.fadeIn = 0;
    s.ease = 1;
    this.add.spawn(s);
  }

  respawnBurst(x: number, y: number): void {
    this.ring(x, y, 0.4, 3.4, 0.55, 0xffe19a, 2.6, 0.12, 0.9, 1);
    this.ring(x, y, 0.2, 2.2, 0.4, 0xffffff, 2.2, 0.1, 0.9, 0.9);
    this.glow(x, y, 1.4, 4.2, 0.5, 0xffd36a, 2.4, 0.7);
    const n = this.n(14);
    for (let i = 0; i < n; i++) {
      const a = this.rng.next() * 6.28;
      this.spark(x + Math.cos(a) * 1.1, y + Math.sin(a) * 1.1, Math.cos(a) * 3, Math.sin(a) * 3 + 2, this.rng.range(0.12, 0.24), this.rng.range(0.5, 0.9), 0xffd86a, 2.8, -3);
    }
  }

  /** Percent steam and embers (fighterFx calls these with its own cadence). */
  steam(x: number, y: number, sev: number): void {
    this.puff(x + this.rng.signed() * 0.35, y, this.rng.signed() * 0.5, this.rng.range(1.2, 2.6), 0.3 + sev * 0.15, 0.8 + sev * 0.4, 0.9, sev > 0.5 ? 0xe09a88 : 0xd7d2cc, 0.18 + sev * 0.17, -0.5, 0.35);
  }

  ember(x: number, y: number, boost = 3): void {
    this.spark(x + this.rng.signed() * 0.4, y, this.rng.signed() * 1.6, this.rng.range(1.5, 4), this.rng.range(0.1, 0.2), this.rng.range(0.6, 1.1), this.rng.next() < 0.5 ? 0xff6a22 : 0xffb347, boost, -2.5);
  }

  /** Long thin speed line along the velocity (camera-space streak across the screen). */
  speedLine(x: number, y: number, angle: number, len: number, hex = 0xffffff): void {
    const s = this.S.reset();
    s.kind = K.streak;
    s.x = x;
    s.y = y;
    s.z = 0.8;
    s.rot = angle;
    s.vx = Math.cos(angle) * 8;
    s.vy = Math.sin(angle) * 8;
    s.sx0 = len * 0.6;
    s.sy0 = 0.07;
    s.sx1 = len;
    s.sy1 = 0.03;
    s.life = 0.16;
    s.rgb(hex, 1.6);
    s.a0 = 0.55;
    s.a1 = 0;
    s.ease = 0.8;
    this.add.spawn(s);
  }

  /**
   * KO blast at (x, y) on the given blast side: a bright beam through the blast line, expanding shockwave rings,
   * radial streaks, embers and the screen flash. `tint` = the KO'd animal's colour.
   */
  ko(x: number, y: number, side: 'left' | 'right' | 'top' | 'bottom', tint: number): void {
    const horizontalBeam = side === 'left' || side === 'right';
    // Beam along the axis perpendicular to the blast line, i.e. toward the playfield (a pillar of light).
    const beamAng = horizontalBeam ? 0 : Math.PI / 2;
    const s = this.S.reset();
    s.kind = K.beam;
    s.x = x;
    s.y = y;
    s.z = 0.9;
    s.rot = beamAng;
    s.sx0 = 34;
    s.sy0 = 1.0;
    s.sx1 = 40;
    s.sy1 = 0.15;
    s.life = 0.55;
    s.param = 0.6;
    s.rgb(0xffffff, 3.4);
    s.a0 = 1;
    s.a1 = 0;
    s.ease = 0.5;
    s.fadeIn = 0.02;
    this.add.spawn(s);
    // coloured outer beam
    s.reset();
    s.kind = K.beam;
    s.x = x;
    s.y = y;
    s.z = 0.88;
    s.rot = beamAng;
    s.sx0 = 30;
    s.sy0 = 3.2;
    s.sx1 = 34;
    s.sy1 = 0.6;
    s.life = 0.7;
    s.param = 0.2;
    s.rgb(tint, 2.4);
    s.a0 = 0.8;
    s.a1 = 0;
    s.ease = 0.55;
    s.fadeIn = 0.02;
    this.add.spawn(s);
    this.star(x, y, 3, 14, 0.4, 0xffffff, 4, 0.3);
    this.ring(x, y, 0.5, 11, 0.6, 0xffffff, 3.0, 0.1, 1, 1);
    this.ring(x, y, 0.3, 7, 0.5, tint, 2.8, 0.14, 1, 1);
    this.ring(x, y, 0.2, 15, 0.9, 0xffe6b0, 1.6, 0.06, 1, 0.8);
    this.glow(x, y, 4, 12, 0.5, 0xffd9a0, 2.4, 0.9);
    const n = this.n(34);
    for (let i = 0; i < n; i++) {
      const a = this.rng.next() * 6.28;
      this.streak(x, y, a, this.rng.range(14, 38), this.rng.range(1.8, 4.5), this.rng.range(0.8, 1.6), this.rng.range(0.12, 0.26), this.rng.range(0.4, 0.85), i % 2 === 0 ? 0xffffff : tint, 2.8, 1, 2.2);
    }
    const e = this.n(26);
    for (let i = 0; i < e; i++) {
      const a = this.rng.next() * 6.28;
      const v = this.rng.range(3, 16);
      this.spark(x, y, Math.cos(a) * v, Math.sin(a) * v, this.rng.range(0.14, 0.34), this.rng.range(0.6, 1.4), this.rng.next() < 0.5 ? tint : 0xffc060, 3, 6);
    }
    this.flash = Math.max(this.flash, 0.75);
    this.flashR = 1;
    this.flashG = 0.93;
    this.flashB = 0.82;
  }
}
