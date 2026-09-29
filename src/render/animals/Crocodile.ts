/**
 * CROCODILE — "The Ambusher" (§8 #3). Long, low jaw + tail silhouette with
 * back scutes and sprawled legs. Snap combo ending in Jaw Crush, Ambush Lunge
 * special, and the Death Roll grab-spin ultimate.
 *
 * v1.1: armoured osteoderm back (cellular pattern) with a double scute ridge
 * running down a laterally-flattened, cross-banded tail; long tapered snout
 * with interlocking teeth rows on both jaws, nostril bulb, raised eye turrets
 * with slit pupils; pale scaled belly; splayed clawed feet.
 */

import * as THREE from 'three';
import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, ramp, smooth01, IMPACT } from './Animator';
import {
  makeMat,
  part,
  pivot,
  sphGeo,
  capGeo,
  coneGeo,
  openCyl,
  eye,
  noTone,
  noOutline,
  paint,
  cellular,
  mixColor,
  shade,
} from './parts';

export class CrocodileRig extends BaseRig {
  private readonly jaw: Joint;
  private readonly tail1: Joint;
  private readonly tail2: Joint;
  private readonly tail3: Joint;

  constructor() {
    super(ANIMALS.crocodile);
    this.hipDrop = 0.12;
    this.strideRate = 0.36;
    this.stepScale = 0.45;
    this.toneBack = 0.22;
    this.toneBelly = 0.4;
    this.slams = [{ action: 'special', at: 0.45, radius: 1.3, kind: 'ring', forward: 1.2 }];
    const p = this.pal;
    const skin = mixColor(p.accent, 0x3f5a2c, 0.35);
    const mBody = makeMat(skin);
    const mDark = makeMat(shade(skin, -0.3));
    const mScute = makeMat(shade(skin, -0.45));
    const mBelly = makeMat(mixColor(p.belly, 0xd9d2a0, 0.5));
    const mTooth = makeMat(0xf1ead2);
    const mNostril = makeMat(0x1a1a14);
    const mClaw = makeMat(0x2a2620);
    const mMouth = makeMat(0xc98f7a);

    const cell: [number, number] = [0, 0];
    const armour = (pp: THREE.Vector3, n: THREE.Vector3, c: THREE.Color): void => {
      if (n.y < 0.15) return;
      cellular(pp.x, pp.y * 0.5, pp.z, 0.13, cell);
      const edge = cell[1] - cell[0];
      c.multiplyScalar(edge < 0.03 ? 0.66 : 0.92 + (cell[0] % 0.05) * 2);
    };
    const bands = (pp: THREE.Vector3, _n: THREE.Vector3, c: THREE.Color): void => {
      if (Math.sin(pp.z * 7.5) > 0.45) c.multiplyScalar(0.7);
    };
    const bellyScales = (pp: THREE.Vector3, _n: THREE.Vector3, c: THREE.Color): void => {
      if (Math.abs(Math.sin(pp.z * 24)) < 0.22) c.multiplyScalar(0.82);
    };

    const bodyN = pivot(0, 0.38, 0);
    this.bodyRoot.add(bodyN);
    bodyN.add(paint(part(capGeo(0.3, 1.0, 8), mBody, 0, 0, 0, 1.18, 1, 0.56, Math.PI / 2), armour));
    bodyN.add(paint(part(sphGeo(0.3, 8, 5), mBelly, 0, -0.1, 0, 0.95, 0.32, 2.3), bellyScales));
    // Double scute ridge (pyramids).
    for (let i = 0; i < 6; i++) {
      const z = 0.55 - i * 0.22;
      for (const sx of [-1, 1]) {
        bodyN.add(part(coneGeo(0.05, 0.1, 4), mScute, sx * 0.12, 0.17, z + (sx > 0 ? 0.08 : 0), 1, 1, 1.5, 0, Math.PI / 4));
      }
    }
    for (let i = 0; i < 4; i++) {
      bodyN.add(part(coneGeo(0.04, 0.07, 4), mScute, (i % 2 ? 1 : -1) * 0.25, 0.1, 0.4 - i * 0.3, 1, 1, 1.4, 0, Math.PI / 4));
    }

    // Head: fixed skull + hinged lower jaw.
    const headN = pivot(0, 0.04, 0.78);
    bodyN.add(headN);
    headN.add(paint(part(sphGeo(0.2, 9, 6), mBody, 0, 0.05, 0.1, 1.05, 0.58, 1.1), armour)); // cranium
    headN.add(part(capGeo(0.14, 0.62, 6), mBody, 0, 0.04, 0.5, 1.25, 1, 0.55, Math.PI / 2)); // snout
    headN.add(part(sphGeo(0.1, 7, 5), mBody, 0, 0.07, 0.86, 1.25, 0.7, 1)); // nostril bulb
    headN.add(noOutline(noTone(part(sphGeo(0.022, 4, 3), mNostril, -0.035, 0.13, 0.9))));
    headN.add(noOutline(noTone(part(sphGeo(0.022, 4, 3), mNostril, 0.035, 0.13, 0.9))));
    for (const sx of [-1, 1]) {
      headN.add(part(sphGeo(0.075, 7, 5), mDark, sx * 0.12, 0.15, 0.06, 1, 0.9, 1.15)); // eye turret
      const e = eye({ r: 0.042, iris: 0xc9c041, side: sx, lateral: 0.7, slit: true });
      e.position.set(sx * 0.125, 0.19, 0.1);
      headN.add(e);
      // Upper teeth rows along the snout sides.
      for (let i = 0; i < 7; i++) {
        const z = 0.2 + i * 0.1;
        const t = part(coneGeo(0.018, 0.07 + (i % 3 === 0 ? 0.03 : 0), 4), mTooth, sx * (0.155 - i * 0.004), -0.03, z, 1, 1, 1, Math.PI);
        headN.add(noOutline(noTone(t)));
      }
    }
    headN.add(noOutline(part(capGeo(0.1, 0.5, 5), mMouth, 0, -0.01, 0.45, 1.2, 1, 0.2, Math.PI / 2))); // palate
    const jawN = pivot(0, -0.05, 0.02);
    headN.add(jawN);
    jawN.add(part(capGeo(0.13, 0.62, 6), mDark, 0, -0.04, 0.42, 1.18, 1, 0.42, Math.PI / 2));
    jawN.add(part(sphGeo(0.12, 7, 4), mBelly, 0, -0.07, 0.35, 1, 0.3, 2.9)); // pale throat
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const z = 0.18 + i * 0.1;
        const t = part(coneGeo(0.017, 0.06 + (i % 2) * 0.02, 4), mTooth, sx * (0.13 - i * 0.004), 0.03, z + 0.05);
        jawN.add(noOutline(noTone(t)));
      }
    }

    // Sprawled legs with splayed clawed feet.
    const mkLeg = (x: number, z: number, side: number, back: boolean): Joint => {
      const g = pivot(x, -0.08, z);
      g.rotation.z = 0.55 * side;
      bodyN.add(g);
      g.add(part(sphGeo(back ? 0.13 : 0.11, 7, 5), mBody, 0, -0.04, 0, 1, 1.2, 1));
      g.add(part(openCyl(0.09, 0.07, 0.32, 6), mDark, 0, -0.16, 0));
      g.add(part(sphGeo(0.1, 6, 4), mDark, 0, -0.32, 0.05, 1.1, 0.45, 1.4));
      for (let k = 0; k < 3; k++) {
        const claw = part(coneGeo(0.02, 0.08, 4), mClaw, (k - 1) * 0.05, -0.33, 0.17, 1, 1, 1, Math.PI / 2);
        g.add(noOutline(noTone(claw)));
      }
      return this.joint(g);
    };

    // Tail: three tapering, laterally flattened segments with scute fins.
    const t1 = pivot(0, 0, -0.72);
    bodyN.add(t1);
    t1.add(paint(part(capGeo(0.2, 0.5, 7), mBody, 0, 0, -0.32, 1.05, 1, 0.8, Math.PI / 2), bands));
    const t2 = pivot(0, 0, -0.68);
    t1.add(t2);
    t2.add(paint(part(capGeo(0.14, 0.48, 6), mBody, 0, 0, -0.28, 0.95, 1, 0.9, Math.PI / 2), bands));
    const t3 = pivot(0, 0, -0.6);
    t2.add(t3);
    t3.add(paint(part(coneGeo(0.12, 0.62, 6), mDark, 0, 0, -0.26, 0.8, 1, 1.1, -Math.PI / 2), bands));
    const fin = (parent: THREE.Object3D, n: number, z0: number, step: number, y: number, s: number): void => {
      for (let i = 0; i < n; i++) {
        for (const sx of [-1, 1]) {
          parent.add(part(coneGeo(0.04 * s, 0.1 * s, 4), mScute, sx * 0.05 * s, y, z0 - i * step + (sx > 0 ? step / 2 : 0), 1, 1, 1.4, 0, Math.PI / 4));
        }
      }
    };
    fin(t1, 3, -0.1, 0.2, 0.18, 1);
    fin(t2, 3, -0.08, 0.18, 0.14, 0.9);
    fin(t3, 2, -0.08, 0.2, 0.09, 0.7);

    this.body = this.joint(bodyN);
    this.head = this.joint(headN);
    this.jaw = this.joint(jawN);
    this.legs = [
      mkLeg(-0.42, 0.5, -1, false),
      mkLeg(0.42, 0.5, 1, false),
      mkLeg(-0.42, -0.5, -1, true),
      mkLeg(0.42, -0.5, 1, true),
    ];
    this.tail1 = this.joint(t1);
    this.tail2 = this.joint(t2);
    this.tail3 = this.joint(t3);
    this.tail = this.tail1;
    this.finalize();
  }

  private tailWave(amp: number, speedMul = 1): void {
    const g = this.gaitPhase * speedMul + this.timePhase * 0.8;
    this.tail1.ry = Math.sin(g) * amp;
    this.tail2.ry = Math.sin(g - 0.9) * amp * 1.3;
    this.tail3.ry = Math.sin(g - 1.8) * amp * 1.6;
  }

  protected poseIdle(t: number): void {
    this.body.py = Math.sin(t) * 0.01;
    this.body.s = 1 + Math.sin(t) * 0.007;
    this.jaw.rx = 0.08 + Math.sin(t * 0.5) * 0.06; // gator gape
    this.head.ry = Math.sin(t * 0.3) * 0.12;
    this.tailWave(0.08);
  }

  protected poseRun(speed: number): void {
    this.quadGait(speed, 0.6, 0.02);
    const k = Math.min(1, speed / this.def.speed);
    this.body.rz = Math.sin(this.gaitPhase) * 0.06 * k; // sprawled waddle roll
    this.body.ry = Math.sin(this.gaitPhase) * 0.05 * k;
    this.tailWave(0.3 * k, 1);
    this.head.ry = Math.sin(this.gaitPhase + Math.PI) * 0.08 * k;
  }

  protected poseAttack(n: 1 | 2 | 3, u: number): void {
    const s = attackCurve(u);
    const open = ramp(u, 0.05, 0.34);
    const close = ramp(u, 0.42, IMPACT);
    if (n === 1) {
      // Straight snap.
      this.jaw.rx = 0.9 * open * (1 - close);
      this.head.rx = -0.25 * open * (1 - close) + 0.15 * Math.max(0, s);
      this.body.pz = 0.28 * Math.max(0, s);
      this.body.rx = -0.05 * s;
    } else if (n === 2) {
      // Side jaw sweep.
      this.head.ry = -1.0 * s;
      this.jaw.rx = 0.5 * open * (1 - close);
      this.body.ry = 0.45 * s;
      this.tail1.ry = 0.4 * s;
      this.tail2.ry = 0.5 * s;
    } else {
      // Jaw Crush: huge gape, lunging crush at 55%, then a worrying shake.
      this.jaw.rx = 1.15 * open * (1 - close);
      this.head.rx = -0.35 * open * (1 - close) + 0.2 * Math.max(0, s);
      this.body.pz = 0.4 * Math.max(0, s);
      const shake = ramp(u, IMPACT, 0.62);
      this.head.ry = Math.sin(u * 40) * 0.12 * shake * (1 - ramp(u, 0.8, 1));
    }
  }

  protected poseSpecial(u: number, _state: FighterState): void {
    // Ambush Lunge: flatten low, then a surging dash pose, jaws ajar.
    const flat = smooth01(ramp(u, 0, 0.2)) * (1 - smooth01(ramp(u, 0.75, 1)));
    const surge = smooth01(ramp(u, 0.2, 0.45)) * (1 - smooth01(ramp(u, 0.8, 1)));
    this.body.py = -0.16 * flat;
    this.body.rx = 0.06 * surge;
    this.jaw.rx = 0.6 * surge;
    this.head.rx = -0.1 * surge;
    for (let i = 0; i < 4; i++) this.legs[i].rx = (i < 2 ? -0.6 : 0.7) * surge;
    this.tailWave(0.4 * surge, 2);
  }

  protected poseUltimate(u: number, _state: FighterState): void {
    // Death Roll (lunge phase): jaws wide, strike at 55%; the roll itself
    // plays while the sim holds the croc in `grab` (see poseGrab).
    const open = ramp(u, 0.05, 0.4);
    const close = ramp(u, 0.45, IMPACT);
    const s = attackCurve(u);
    this.jaw.rx = 1.2 * open * (1 - close);
    this.head.rx = -0.4 * open * (1 - close);
    this.body.pz = 0.5 * Math.max(0, s);
    this.body.py = -0.08 * open;
    this.tailWave(0.35, 2);
  }

  protected override poseGrab(_u: number, _state: FighterState): void {
    // The death roll: continuous spin around the long axis, jaws clamped.
    const spin = this.timePhase * 9;
    this.body.rz = spin;
    this.jaw.rx = 0.12;
    this.head.rx = 0.1;
    for (let i = 0; i < 4; i++) this.legs[i].rx = 0.5;
    this.tail1.ry = Math.sin(spin * 0.5) * 0.3;
    this.tail2.ry = Math.sin(spin * 0.5 - 1) * 0.4;
  }

  protected poseBlock(t: number): void {
    // Armored hunker: head tucked low behind the scutes.
    this.body.py = -0.14;
    this.head.rx = 0.3;
    this.head.py = -0.06;
    this.jaw.rx = 0.02;
    for (let i = 0; i < 4; i++) this.legs[i].rx = (i < 2 ? 0.3 : -0.3) + Math.sin(t * 2) * 0.01;
    this.tail1.ry = Math.sin(t * 1.2) * 0.06;
  }

  protected override poseDead(): void {
    // Low animal: roll belly-up instead of toppling sideways.
    const t = this.deathT;
    const k = smooth01(Math.min(1, t / 0.6));
    this.body.rz = Math.PI * k;
    this.body.py = 0.1 * k;
    this.jaw.rx = 0.5 * k;
    for (let i = 0; i < 4; i++) this.legs[i].rx = 0.4 * k;
    this.tail1.ry = 0.2 * k;
  }
}
