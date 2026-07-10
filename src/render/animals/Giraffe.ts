/**
 * GIRAFFE — "The High Tower" (§8 #9). ~4 m tall: long legs, two-segment neck
 * with ossicones and coat patches. Neck-swing combo ending in Skull Hammer,
 * Thunder Kick special, and the double 360° Guillotine Spin ultimate.
 */

import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, impactPulse, ramp, smooth01, easeInOutCubic } from './Animator';
import { makeMat, mesh, pivot, boxGeo, sphGeo, coneGeo, cylGeo, leg } from './parts';

export class GiraffeRig extends BaseRig {
  private readonly neck1: Joint;
  private readonly neck2: Joint;

  constructor() {
    super(ANIMALS.giraffe);
    this.hipDrop = 1.15;
    this.strideRate = 0.22;
    const p = this.pal;
    const mBody = makeMat(p.accent);
    const mDark = makeMat(p.dark);
    const mPatch = makeMat(p.darker);
    const mBelly = makeMat(p.belly);
    const mHoof = makeMat(p.black);
    const mBone = makeMat(p.bone);

    const bodyN = pivot(0, 1.62, 0);
    this.bodyRoot.add(bodyN);
    const torso = mesh(boxGeo(0.66, 0.72, 1.25), mBody, 0, 0, -0.05);
    torso.rotation.x = -0.14; // shoulders higher than hips
    bodyN.add(torso);
    bodyN.add(mesh(boxGeo(0.5, 0.3, 1.0), mBelly, 0, -0.38, -0.05));
    // Coat patches proud of the hide.
    const patch = (x: number, y: number, z: number, s: number): void => {
      bodyN.add(mesh(boxGeo(s, s * 0.8, 0.03), mPatch, x, y, z));
    };
    patch(-0.35, 0.15, 0.3, 0.24);
    patch(0.35, 0.05, 0.1, 0.28);
    patch(-0.35, -0.1, -0.35, 0.26);
    patch(0.35, 0.2, -0.45, 0.22);

    // Two-segment neck reaching ~4 m, then the small horned head.
    const neck1N = pivot(0, 0.4, 0.52);
    neck1N.rotation.x = -0.42;
    bodyN.add(neck1N);
    neck1N.add(mesh(cylGeo(0.14, 0.18, 0.95, 6), mBody, 0, 0.47, 0));
    neck1N.add(mesh(boxGeo(0.22, 0.6, 0.03), mPatch, 0, 0.4, -0.12));
    const neck2N = pivot(0, 0.95, 0);
    neck2N.rotation.x = 0.12;
    neck1N.add(neck2N);
    neck2N.add(mesh(cylGeo(0.1, 0.14, 0.9, 6), mBody, 0, 0.45, 0));
    const headN = pivot(0, 0.95, 0);
    headN.rotation.x = 0.85; // level the head off the raked neck
    neck2N.add(headN);
    headN.add(mesh(boxGeo(0.2, 0.2, 0.42), mBody, 0, 0.02, 0.12));
    headN.add(mesh(boxGeo(0.14, 0.14, 0.18), mDark, 0, -0.02, 0.36)); // muzzle
    // Ossicones.
    const ossL = pivot(-0.07, 0.14, 0.02);
    ossL.add(mesh(cylGeo(0.02, 0.02, 0.12, 4), mDark, 0, 0.06, 0));
    ossL.add(mesh(sphGeo(0.035, 5, 4), mBone, 0, 0.14, 0));
    const ossR = pivot(0.07, 0.14, 0.02);
    ossR.add(mesh(cylGeo(0.02, 0.02, 0.12, 4), mDark, 0, 0.06, 0));
    ossR.add(mesh(sphGeo(0.035, 5, 4), mBone, 0, 0.14, 0));
    headN.add(ossL, ossR);
    headN.add(mesh(coneGeo(0.05, 0.14, 4), mBody, -0.13, 0.08, -0.02)); // ears
    headN.add(mesh(coneGeo(0.05, 0.14, 4), mBody, 0.13, 0.08, -0.02));

    // Long legs.
    const mkLeg = (x: number, z: number): Joint => {
      const g = leg(mBody, 0.1, 0.075, 1.6, mHoof);
      g.position.set(x, -0.02, z);
      bodyN.add(g);
      return this.joint(g);
    };

    const tailN = pivot(0, 0.2, -0.65);
    tailN.rotation.x = 1.15;
    bodyN.add(tailN);
    tailN.add(mesh(cylGeo(0.03, 0.02, 0.7, 4), mDark, 0, -0.35, 0));
    tailN.add(mesh(sphGeo(0.05, 5, 4), mPatch, 0, -0.72, 0));

    this.body = this.joint(bodyN);
    this.legs = [mkLeg(-0.28, 0.48), mkLeg(0.28, 0.48), mkLeg(-0.28, -0.5), mkLeg(0.28, -0.5)];
    this.neck1 = this.joint(neck1N);
    this.neck2 = this.joint(neck2N);
    this.head = this.joint(headN);
    this.tail = this.joint(tailN);
    this.finalize();
  }

  protected poseIdle(t: number): void {
    this.body.py = Math.sin(t) * 0.02;
    this.body.s = 1 + Math.sin(t) * 0.006;
    this.neck1.rx = Math.sin(t * 0.5) * 0.05;
    this.neck2.ry = Math.sin(t * 0.35) * 0.12;
    this.head.ry = Math.sin(t * 0.6) * 0.25;
    this.head.rz = Math.sin(t * 4.7) * 0.04 * smooth01(Math.sin(t * 0.27) * 4 - 3); // ear flick
    if (this.tail) this.tail.ry = Math.sin(t * 1.6) * 0.4;
  }

  protected poseRun(speed: number): void {
    this.quadGait(speed, 0.55, 0.09);
    const k = Math.min(1, speed / this.def.speed);
    // The whole neck pumps fore-aft with the stride.
    this.neck1.rx = Math.sin(this.gaitPhase * 2) * 0.08 * k + 0.1 * k;
    this.neck2.rx = Math.sin(this.gaitPhase * 2 + 0.6) * 0.05 * k;
    this.head.rx = -0.12 * k;
    if (this.tail) this.tail.rx = -0.5 * k;
  }

  protected poseAttack(n: 1 | 2 | 3, u: number): void {
    const s = attackCurve(u);
    if (n === 1 || n === 2) {
      // Necking blows: the neck is the club, swung wide left then right.
      const side = n === 1 ? 1 : -1;
      this.neck1.rx = 0.55 * Math.abs(s);
      this.neck1.rz = -0.7 * s * side;
      this.neck2.rz = -0.5 * s * side;
      this.head.rz = 0.3 * s * side;
      this.body.ry = 0.22 * s * side;
      this.body.rz = -0.08 * s * side;
    } else {
      // Skull Hammer: rear the neck sky-high, then the overhead piledriver.
      const rear = smooth01(ramp(u, 0, 0.36));
      const slam = impactPulse(u, 0.11);
      this.neck1.rx = -0.55 * rear * (1 - slam) + 1.05 * slam;
      this.neck2.rx = -0.3 * rear * (1 - slam) + 0.45 * slam;
      this.head.rx = -0.3 * rear * (1 - slam) + 0.5 * slam;
      this.body.rx = -0.1 * rear + 0.14 * slam;
      this.body.py = -0.08 * slam;
    }
  }

  protected poseSpecial(u: number, _state: FighterState): void {
    // Thunder Kick: rock back and fire both forelegs at the impact instant.
    const rear = smooth01(ramp(u, 0, 0.34));
    const kick = impactPulse(u, 0.1);
    this.body.rx = -0.22 * rear * (1 - kick) - 0.1 * kick;
    this.body.py = -0.05 * rear;
    this.legs[0].rx = 0.5 * rear * (1 - kick) - 1.9 * kick;
    this.legs[1].rx = 0.5 * rear * (1 - kick) - 1.9 * kick;
    this.legs[2].rx = -0.3 * rear;
    this.legs[3].rx = -0.3 * rear;
    this.neck1.rx = 0.3 * rear * (1 - kick) - 0.15 * kick;
    this.head.rx = 0.2 * rear;
  }

  protected poseUltimate(u: number, _state: FighterState): void {
    // Guillotine Spin: neck lowered to a scythe, two full 360° body turns —
    // each sweep crosses the front at an even cadence; the second dips lower.
    const k = smooth01(ramp(u, 0, 0.15)) * (1 - smooth01(ramp(u, 0.9, 1)));
    const spin = easeInOutCubic(ramp(u, 0.08, 0.95)) * Math.PI * 4;
    const second = ramp(u, 0.5, 0.6);
    this.body.ry = spin;
    this.neck1.rx = (0.85 + 0.2 * second) * k;
    this.neck2.rx = 0.25 * k;
    this.head.rx = -1.0 * k;
    this.body.py = -0.12 * k - 0.08 * second * k;
    this.body.rx = 0.06 * k;
    this.legs[0].rx = -0.2 * k;
    this.legs[1].rx = -0.2 * k;
    this.legs[2].rx = 0.25 * k;
    this.legs[3].rx = 0.25 * k;
    if (this.tail) this.tail.rx = -0.6 * k;
  }

  protected poseBlock(t: number): void {
    // Rear back: neck drawn up and away, forelegs braced wide.
    this.body.rx = -0.12 + Math.sin(t * 2) * 0.008;
    this.neck1.rx = -0.3;
    this.neck2.rx = -0.15;
    this.head.rx = 0.35;
    this.legs[0].rx = -0.35;
    this.legs[0].rz = -0.12;
    this.legs[1].rx = -0.35;
    this.legs[1].rz = 0.12;
    this.legs[2].rx = 0.2;
    this.legs[3].rx = 0.2;
  }

  protected override poseGrabbed(t: number): void {
    // Too tall to hoist: dragged down instead.
    this.body.py = -0.3;
    this.body.rx = 0.2;
    this.neck1.rx = 0.5 + Math.sin(t * 10) * 0.08;
    this.neck2.rx = 0.3;
    this.head.ry = Math.sin(t * 12) * 0.3;
    for (let i = 0; i < 4; i++) this.legs[i].rx = Math.sin(t * 10 + i * 1.5) * 0.25;
  }
}
