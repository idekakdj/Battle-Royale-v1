/**
 * RHINO — "The Battering Ram" (§8 #5). Horn + armor-plate silhouette. Horn
 * hooks and the launching Horn Fling finisher, Lockdown Charge special, and
 * the steerable Seismic Stampede ultimate.
 */

import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, impactPulse, ramp, smooth01 } from './Animator';
import { makeMat, mesh, pivot, boxGeo, sphGeo, coneGeo, cylGeo, leg } from './parts';

export class RhinoRig extends BaseRig {
  constructor() {
    super(ANIMALS.rhino);
    this.hipDrop = 0.45;
    this.strideRate = 0.27;
    const p = this.pal;
    const mBody = makeMat(p.accent);
    const mPlate = makeMat(p.light);
    const mDark = makeMat(p.dark);
    const mHorn = makeMat(p.bone);
    const mBlack = makeMat(p.eye);

    const bodyN = pivot(0, 1.02, 0);
    this.bodyRoot.add(bodyN);
    bodyN.add(mesh(boxGeo(0.92, 0.8, 1.8), mBody, 0, 0, -0.05));
    // Armor plates: shoulder and hip slabs proud of the hide.
    const shoulder = mesh(boxGeo(1.0, 0.55, 0.55), mPlate, 0, 0.15, 0.45);
    bodyN.add(shoulder);
    bodyN.add(mesh(boxGeo(0.98, 0.5, 0.5), mPlate, 0, 0.12, -0.62));
    bodyN.add(mesh(boxGeo(0.8, 0.2, 0.9), mDark, 0, -0.42, -0.05)); // underbelly

    // Head angled down, bearing the horns.
    const headN = pivot(0, 0.12, 0.95);
    headN.rotation.x = 0.3;
    bodyN.add(headN);
    headN.add(mesh(boxGeo(0.5, 0.5, 0.75), mBody, 0, -0.05, 0.25));
    const horn1 = mesh(coneGeo(0.13, 0.7, 6), mHorn, 0, 0.18, 0.58);
    horn1.rotation.x = -0.55;
    headN.add(horn1);
    const horn2 = mesh(coneGeo(0.08, 0.3, 6), mHorn, 0, 0.28, 0.3);
    horn2.rotation.x = -0.4;
    headN.add(horn2);
    headN.add(mesh(coneGeo(0.07, 0.18, 5), mDark, -0.2, 0.32, -0.1)); // ears
    headN.add(mesh(coneGeo(0.07, 0.18, 5), mDark, 0.2, 0.32, -0.1));
    headN.add(mesh(sphGeo(0.035, 5, 4), mBlack, -0.2, 0.12, 0.42));
    headN.add(mesh(sphGeo(0.035, 5, 4), mBlack, 0.2, 0.12, 0.42));

    const mkLeg = (x: number, z: number): Joint => {
      const g = leg(mBody, 0.18, 0.15, 0.68, mDark);
      g.position.set(x, -0.35, z);
      bodyN.add(g);
      return this.joint(g);
    };

    const tailN = pivot(0, 0.3, -0.95);
    tailN.rotation.x = 1.0;
    bodyN.add(tailN);
    tailN.add(mesh(cylGeo(0.04, 0.03, 0.45, 5), mDark, 0, -0.22, 0));
    tailN.add(mesh(sphGeo(0.05, 5, 4), mDark, 0, -0.46, 0));

    this.body = this.joint(bodyN);
    this.head = this.joint(headN);
    this.legs = [mkLeg(-0.4, 0.62), mkLeg(0.4, 0.62), mkLeg(-0.4, -0.62), mkLeg(0.4, -0.62)];
    this.tail = this.joint(tailN);
    this.finalize();
  }

  protected poseIdle(t: number): void {
    this.body.py = Math.sin(t) * 0.014;
    this.body.s = 1 + Math.sin(t) * 0.007;
    this.head.ry = Math.sin(t * 0.28) * 0.14;
    this.head.rx = Math.max(0, Math.sin(t * 0.15)) * 0.12; // pawing snuffle
    if (this.tail) this.tail.ry = Math.sin(t * 1.8) * 0.35;
  }

  protected poseRun(speed: number): void {
    this.quadGait(speed, 0.6, 0.07);
    const k = Math.min(1, speed / this.def.speed);
    this.head.rx = 0.1 * k; // head lowers as it builds steam
    this.body.rz = Math.sin(this.gaitPhase) * 0.03 * k;
    if (this.tail) this.tail.ry = Math.sin(this.gaitPhase * 2) * 0.25 * k;
  }

  protected poseAttack(n: 1 | 2 | 3, u: number): void {
    const s = attackCurve(u);
    if (n === 1 || n === 2) {
      // Horn hooks: dip then flick up and across.
      const side = n === 1 ? 1 : -1;
      this.head.rx = 0.5 * Math.min(0, s) - 0.7 * Math.max(0, s);
      this.head.rz = -0.45 * s * side;
      this.head.ry = -0.3 * s * side;
      this.body.rx = 0.1 * Math.min(0, s) - 0.12 * Math.max(0, s);
      this.body.ry = 0.2 * s * side;
    } else {
      // Horn Fling: deep dig, violent upward toss peaking at 55%.
      const dig = smooth01(ramp(u, 0, 0.35));
      const toss = impactPulse(u, 0.12);
      this.head.rx = 0.8 * dig * (1 - toss) - 1.0 * toss;
      this.body.rx = 0.22 * dig * (1 - toss) - 0.3 * toss;
      this.body.py = -0.12 * dig * (1 - toss) + 0.1 * toss;
      this.legs[0].rx = -0.5 * toss;
      this.legs[1].rx = -0.5 * toss;
    }
  }

  protected poseSpecial(u: number, _state: FighterState): void {
    // Lockdown Charge: horn levelled, body low, driving gallop.
    const k = smooth01(ramp(u, 0, 0.18)) * (1 - smooth01(ramp(u, 0.88, 1)));
    this.chargePose(k, this.timePhase * 15);
  }

  protected poseUltimate(u: number, _state: FighterState): void {
    // Seismic Stampede: sustained, heavier charge with a swaying head that
    // sells the steerable rampage; CC-immune juggernaut lean.
    const k = smooth01(ramp(u, 0, 0.12));
    this.chargePose(k, this.timePhase * 16);
    this.head.ry = Math.sin(this.timePhase * 5) * 0.18 * k;
    this.body.rz = Math.sin(this.timePhase * 8) * 0.045 * k;
  }

  private chargePose(k: number, g: number): void {
    this.body.rx = 0.16 * k;
    this.body.py = -0.08 * k;
    this.head.rx = 0.35 * k; // horn presented
    for (let i = 0; i < 4; i++) {
      this.legs[i].rx = Math.sin(g + (i % 2 === 0 ? 0 : Math.PI) + (i < 2 ? 0 : 0.9)) * 0.7 * k;
    }
    this.body.py += Math.abs(Math.sin(g)) * 0.05 * k;
    if (this.tail) this.tail.rx = -0.4 * k;
  }

  protected poseBlock(t: number): void {
    // Plant and present the horn — attackers eat thorns (§8 block perk).
    this.body.py = -0.1;
    this.body.rx = 0.12 + Math.sin(t * 2) * 0.01;
    this.head.rx = 0.55;
    this.legs[0].rx = -0.3;
    this.legs[1].rx = -0.3;
    this.legs[2].rx = 0.3;
    this.legs[3].rx = 0.3;
  }
}
