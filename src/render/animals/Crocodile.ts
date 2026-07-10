/**
 * CROCODILE — "The Ambusher" (§8 #3). Long, low jaw + tail silhouette with
 * back scutes and sprawled legs. Snap combo ending in Jaw Crush, Ambush Lunge
 * special, and the Death Roll grab-spin ultimate.
 */

import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, ramp, smooth01, IMPACT } from './Animator';
import { makeMat, mesh, pivot, boxGeo, sphGeo, cylGeo } from './parts';

export class CrocodileRig extends BaseRig {
  private readonly jaw: Joint;
  private readonly tail1: Joint;
  private readonly tail2: Joint;
  private readonly tail3: Joint;

  constructor() {
    super(ANIMALS.crocodile);
    this.hipDrop = 0.12;
    this.strideRate = 0.36;
    const p = this.pal;
    const mBody = makeMat(p.accent);
    const mDark = makeMat(p.dark);
    const mScute = makeMat(p.darker);
    const mBelly = makeMat(p.belly);
    const mTooth = makeMat(p.bone);
    const mBlack = makeMat(p.eye);

    const bodyN = pivot(0, 0.38, 0);
    this.bodyRoot.add(bodyN);
    bodyN.add(mesh(boxGeo(0.68, 0.32, 1.5), mBody, 0, 0, 0));
    bodyN.add(mesh(boxGeo(0.56, 0.1, 1.3), mBelly, 0, -0.19, 0));
    // Back scutes: two staggered ridge rows.
    for (let i = 0; i < 4; i++) {
      bodyN.add(mesh(boxGeo(0.1, 0.1, 0.16), mScute, -0.14, 0.2, 0.5 - i * 0.34));
      bodyN.add(mesh(boxGeo(0.1, 0.1, 0.16), mScute, 0.14, 0.2, 0.34 - i * 0.34));
    }

    // Head: fixed skull + hinged lower jaw.
    const headN = pivot(0, 0.04, 0.78);
    bodyN.add(headN);
    headN.add(mesh(boxGeo(0.42, 0.16, 0.88), mBody, 0, 0.05, 0.4)); // upper snout
    headN.add(mesh(sphGeo(0.07, 5, 4), mDark, -0.13, 0.16, 0.06)); // eye ridges
    headN.add(mesh(sphGeo(0.07, 5, 4), mDark, 0.13, 0.16, 0.06));
    headN.add(mesh(sphGeo(0.03, 5, 4), mBlack, -0.13, 0.2, 0.09));
    headN.add(mesh(sphGeo(0.03, 5, 4), mBlack, 0.13, 0.2, 0.09));
    headN.add(mesh(boxGeo(0.09, 0.05, 0.09), mDark, 0, 0.11, 0.8)); // nostril bump
    // Teeth strips on the upper snout.
    headN.add(mesh(boxGeo(0.03, 0.05, 0.7), mTooth, -0.18, -0.03, 0.42));
    headN.add(mesh(boxGeo(0.03, 0.05, 0.7), mTooth, 0.18, -0.03, 0.42));
    const jawN = pivot(0, -0.05, 0.02);
    headN.add(jawN);
    jawN.add(mesh(boxGeo(0.36, 0.1, 0.8), mDark, 0, -0.04, 0.4));
    jawN.add(mesh(boxGeo(0.03, 0.05, 0.62), mTooth, -0.15, 0.03, 0.42));
    jawN.add(mesh(boxGeo(0.03, 0.05, 0.62), mTooth, 0.15, 0.03, 0.42));

    // Sprawled stubby legs.
    const mkLeg = (x: number, z: number, side: number): Joint => {
      const g = pivot(x, -0.08, z);
      g.rotation.z = 0.55 * side;
      bodyN.add(g);
      g.add(mesh(cylGeo(0.09, 0.075, 0.32, 6), mDark, 0, -0.16, 0));
      g.add(mesh(sphGeo(0.09, 5, 4), mBody, 0, -0.32, 0.04));
      return this.joint(g);
    };

    // Tail: three tapering segments with ridge fins.
    const t1 = pivot(0, 0, -0.72);
    bodyN.add(t1);
    t1.add(mesh(boxGeo(0.46, 0.26, 0.7), mBody, 0, 0, -0.32));
    t1.add(mesh(boxGeo(0.08, 0.12, 0.5), mScute, 0, 0.17, -0.32));
    const t2 = pivot(0, 0, -0.68);
    t1.add(t2);
    t2.add(mesh(boxGeo(0.3, 0.2, 0.62), mBody, 0, 0, -0.28));
    t2.add(mesh(boxGeo(0.06, 0.12, 0.44), mScute, 0, 0.14, -0.28));
    const t3 = pivot(0, 0, -0.6);
    t2.add(t3);
    t3.add(mesh(boxGeo(0.16, 0.13, 0.56), mDark, 0, 0, -0.26));
    t3.add(mesh(boxGeo(0.05, 0.12, 0.36), mScute, 0, 0.1, -0.26));

    this.body = this.joint(bodyN);
    this.head = this.joint(headN);
    this.jaw = this.joint(jawN);
    this.legs = [mkLeg(-0.42, 0.5, -1), mkLeg(0.42, 0.5, 1), mkLeg(-0.42, -0.5, -1), mkLeg(0.42, -0.5, 1)];
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
