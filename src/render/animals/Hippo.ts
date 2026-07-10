/**
 * HIPPO — "The Riverlord" (§8 #4). Huge barrel body and a colossal tusked maw.
 * Head-swing combo with a chomping finisher, River Rush charge special, and
 * the Colossal Chomp ultimate (maw gapes through the windup, slams at 55%).
 */

import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, ramp, smooth01, IMPACT } from './Animator';
import { makeMat, mesh, pivot, boxGeo, sphGeo, coneGeo, cylGeo, leg } from './parts';

export class HippoRig extends BaseRig {
  private readonly jaw: Joint;

  constructor() {
    super(ANIMALS.hippo);
    this.hipDrop = 0.38;
    this.strideRate = 0.26;
    const p = this.pal;
    const mBody = makeMat(p.accent);
    const mDark = makeMat(p.dark);
    const mBelly = makeMat(p.belly);
    const mTusk = makeMat(p.bone);
    const mBlack = makeMat(p.eye);

    const bodyN = pivot(0, 0.98, 0);
    this.bodyRoot.add(bodyN);
    const barrel = mesh(sphGeo(0.62, 9, 7), mBody, 0, 0, -0.1);
    barrel.scale.set(1.05, 0.95, 1.7);
    bodyN.add(barrel);
    const belly = mesh(sphGeo(0.55, 8, 6), mBelly, 0, -0.22, -0.1);
    belly.scale.set(0.95, 0.75, 1.55);
    bodyN.add(belly);

    // Massive head + hinged maw.
    const headN = pivot(0, 0.02, 0.95);
    bodyN.add(headN);
    headN.add(mesh(boxGeo(0.72, 0.52, 0.6), mBody, 0, 0.1, 0.1));
    headN.add(mesh(boxGeo(0.6, 0.34, 0.55), mBody, 0, -0.02, 0.55)); // snout
    headN.add(mesh(coneGeo(0.06, 0.14, 5), mDark, -0.28, 0.42, -0.1)); // ears
    headN.add(mesh(coneGeo(0.06, 0.14, 5), mDark, 0.28, 0.42, -0.1));
    headN.add(mesh(sphGeo(0.06, 5, 4), mDark, -0.24, 0.34, 0.28)); // eye bumps
    headN.add(mesh(sphGeo(0.06, 5, 4), mDark, 0.24, 0.34, 0.28));
    headN.add(mesh(sphGeo(0.028, 5, 4), mBlack, -0.24, 0.37, 0.33));
    headN.add(mesh(sphGeo(0.028, 5, 4), mBlack, 0.24, 0.37, 0.33));
    const jawN = pivot(0, -0.2, 0.12);
    headN.add(jawN);
    jawN.add(mesh(boxGeo(0.62, 0.26, 0.68), mDark, 0, -0.1, 0.38));
    // Tusks rising from the lower jaw.
    const tuskL = mesh(coneGeo(0.05, 0.28, 5), mTusk, -0.24, 0.1, 0.68);
    const tuskR = mesh(coneGeo(0.05, 0.28, 5), mTusk, 0.24, 0.1, 0.68);
    tuskL.rotation.x = 0.25;
    tuskR.rotation.x = 0.25;
    jawN.add(tuskL, tuskR);
    jawN.add(mesh(coneGeo(0.035, 0.14, 5), mTusk, -0.12, 0.06, 0.72));
    jawN.add(mesh(coneGeo(0.035, 0.14, 5), mTusk, 0.12, 0.06, 0.72));

    // Stout legs.
    const mkLeg = (x: number, z: number): Joint => {
      const g = leg(mBody, 0.17, 0.15, 0.62, mDark);
      g.position.set(x, -0.36, z);
      bodyN.add(g);
      return this.joint(g);
    };

    // Tiny tail.
    const tailN = pivot(0, 0.22, -1.05);
    tailN.rotation.x = 0.9;
    bodyN.add(tailN);
    tailN.add(mesh(cylGeo(0.045, 0.03, 0.3, 5), mDark, 0, -0.15, 0));

    this.body = this.joint(bodyN);
    this.head = this.joint(headN);
    this.jaw = this.joint(jawN);
    this.legs = [mkLeg(-0.42, 0.62), mkLeg(0.42, 0.62), mkLeg(-0.42, -0.68), mkLeg(0.42, -0.68)];
    this.tail = this.joint(tailN);
    this.finalize();
  }

  protected poseIdle(t: number): void {
    this.body.py = Math.sin(t) * 0.016;
    this.body.s = 1 + Math.sin(t) * 0.009;
    this.head.ry = Math.sin(t * 0.3) * 0.12;
    this.jaw.rx = 0.06 + Math.max(0, Math.sin(t * 0.17)) * 0.5; // lazy territorial yawn
    if (this.tail) this.tail.ry = Math.sin(t * 2.2) * 0.4; // tail swish
  }

  protected poseRun(speed: number): void {
    this.quadGait(speed, 0.55, 0.06);
    const k = Math.min(1, speed / this.def.speed);
    this.head.rx = -0.08 * k;
    this.body.rz = Math.sin(this.gaitPhase) * 0.04 * k; // ponderous roll
    if (this.tail) this.tail.ry = Math.sin(this.gaitPhase * 2) * 0.3 * k;
  }

  protected poseAttack(n: 1 | 2 | 3, u: number): void {
    const s = attackCurve(u);
    if (n === 1 || n === 2) {
      // Sweeping head swings with the maw half open.
      const side = n === 1 ? 1 : -1;
      this.head.ry = -0.9 * s * side;
      this.head.rx = -0.1 * Math.abs(s);
      this.jaw.rx = 0.45 * Math.abs(s);
      this.body.ry = 0.3 * s * side;
      this.body.rx = -0.05 * s;
      this.legs[0].rx = -0.2 * s * side;
      this.legs[1].rx = 0.2 * s * side;
    } else {
      // Chomp finisher: gape then slam shut at the impact instant.
      const open = ramp(u, 0.05, 0.36);
      const close = ramp(u, 0.44, IMPACT);
      this.jaw.rx = 1.0 * open * (1 - close);
      this.head.rx = -0.4 * open * (1 - close) + 0.25 * Math.max(0, s);
      this.body.pz = 0.25 * Math.max(0, s);
      this.body.rx = 0.08 * Math.max(0, s);
    }
  }

  protected poseSpecial(u: number, _state: FighterState): void {
    // River Rush: bulldozing charge — head low, maw open, galloping.
    const k = smooth01(ramp(u, 0, 0.2)) * (1 - smooth01(ramp(u, 0.85, 1)));
    this.body.rx = 0.14 * k;
    this.head.rx = -0.15 * k;
    this.jaw.rx = 0.7 * k;
    const g = this.timePhase * 14;
    for (let i = 0; i < 4; i++) {
      this.legs[i].rx = Math.sin(g + (i % 2 === 0 ? 0 : Math.PI) + (i < 2 ? 0 : 0.8)) * 0.6 * k;
    }
    this.body.py = Math.abs(Math.sin(g)) * 0.05 * k;
  }

  protected poseUltimate(u: number, _state: FighterState): void {
    // Colossal Chomp: the maw cranks open through the 1 s windup and slams
    // shut exactly at 55%, whole body pitching into the bite.
    const open = smooth01(ramp(u, 0, 0.45));
    const close = ramp(u, 0.48, IMPACT);
    const after = ramp(u, IMPACT, 0.75);
    this.jaw.rx = 1.5 * open * (1 - close);
    this.head.rx = -0.55 * open * (1 - close) + 0.3 * close * (1 - after);
    this.body.rx = -0.12 * open * (1 - close) + 0.15 * close * (1 - after);
    this.body.pz = 0.35 * close * (1 - after);
    this.body.py = -0.1 * close * (1 - after);
    this.legs[0].rx = -0.3 * open * (1 - close);
    this.legs[1].rx = -0.3 * open * (1 - close);
  }

  protected poseBlock(t: number): void {
    // Present the forehead: head down, maw clamped, legs planted wide.
    this.body.py = -0.1;
    this.body.rx = 0.1 + Math.sin(t * 2) * 0.01;
    this.head.rx = 0.45;
    this.jaw.rx = 0;
    this.legs[0].rx = -0.25;
    this.legs[1].rx = -0.25;
    this.legs[2].rx = 0.25;
    this.legs[3].rx = 0.25;
  }
}
