/**
 * LION — "The King" (§8 #1). Mane silhouette, paw-swipe combo ending in the
 * Maul Bite, Pounce leap special, King's Roar rear-up ultimate.
 */

import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, impactPulse, ramp, smooth01, IMPACT } from './Animator';
import { makeMat, mesh, pivot, boxGeo, sphGeo, coneGeo, capGeo, cylGeo, leg } from './parts';

export class LionRig extends BaseRig {
  private readonly neck: Joint;
  private readonly jaw: Joint;
  private readonly mane: Joint;
  private readonly tail2: Joint;

  constructor() {
    super(ANIMALS.lion);
    this.hipDrop = 0.55;
    this.strideRate = 0.34;
    const p = this.pal;
    const mBody = makeMat(p.accent);
    const mDark = makeMat(p.dark);
    const mMane = makeMat(p.darker);
    const mBelly = makeMat(p.belly);
    const mBlack = makeMat(p.black);

    const bodyN = pivot(0, 0.92, 0);
    this.bodyRoot.add(bodyN);
    const torso = mesh(capGeo(0.34, 0.85, 7), mBody, 0, 0.02, -0.05);
    torso.rotation.x = Math.PI / 2;
    bodyN.add(torso);
    bodyN.add(mesh(sphGeo(0.36, 7, 5), mBody, 0, 0.06, 0.38)); // chest
    bodyN.add(mesh(boxGeo(0.46, 0.24, 0.7), mBelly, 0, -0.24, 0.0));

    // Legs (FL, FR, BL, BR).
    const mkLeg = (x: number, z: number): Joint => {
      const g = leg(mDark, 0.11, 0.085, 0.92, mBody);
      g.position.set(x, 0, z);
      bodyN.add(g);
      return this.joint(g);
    };

    // Neck, mane, head, jaw.
    const neckN = pivot(0, 0.2, 0.52);
    bodyN.add(neckN);
    const maneN = pivot(0, 0.1, 0.12);
    neckN.add(maneN);
    const maneM = mesh(sphGeo(0.42, 8, 6), mMane, 0, 0, 0);
    maneM.scale.set(1.15, 1.2, 0.55);
    maneN.add(maneM);
    const headN = pivot(0, 0.16, 0.3);
    neckN.add(headN);
    headN.add(mesh(boxGeo(0.34, 0.3, 0.34), mBody, 0, 0.02, 0.08));
    headN.add(mesh(boxGeo(0.2, 0.15, 0.28), mBody, 0, -0.03, 0.34)); // muzzle
    headN.add(mesh(boxGeo(0.09, 0.05, 0.06), mBlack, 0, 0.03, 0.48)); // nose
    const earL = mesh(coneGeo(0.07, 0.12, 5), mDark, -0.14, 0.2, 0.02);
    const earR = mesh(coneGeo(0.07, 0.12, 5), mDark, 0.14, 0.2, 0.02);
    headN.add(earL, earR);
    headN.add(mesh(sphGeo(0.035, 5, 4), mBlack, -0.1, 0.09, 0.26));
    headN.add(mesh(sphGeo(0.035, 5, 4), mBlack, 0.1, 0.09, 0.26));
    const jawN = pivot(0, -0.1, 0.14);
    headN.add(jawN);
    jawN.add(mesh(boxGeo(0.17, 0.08, 0.26), mDark, 0, -0.02, 0.16));

    // Tail: two segments + tuft.
    const tail1N = pivot(0, 0.14, -0.52);
    tail1N.rotation.x = 1.25;
    bodyN.add(tail1N);
    tail1N.add(mesh(cylGeo(0.05, 0.04, 0.48, 5), mBody, 0, -0.24, 0));
    const tail2N = pivot(0, -0.46, 0);
    tail2N.rotation.x = 0.4;
    tail1N.add(tail2N);
    tail2N.add(mesh(cylGeo(0.035, 0.03, 0.34, 5), mBody, 0, -0.17, 0));
    tail2N.add(mesh(sphGeo(0.07, 5, 4), mMane, 0, -0.36, 0));

    this.body = this.joint(bodyN);
    this.legs = [mkLeg(-0.3, 0.44), mkLeg(0.3, 0.44), mkLeg(-0.3, -0.42), mkLeg(0.3, -0.42)];
    this.neck = this.joint(neckN);
    this.head = this.joint(headN);
    this.jaw = this.joint(jawN);
    this.mane = this.joint(maneN);
    this.tail = this.joint(tail1N);
    this.tail2 = this.joint(tail2N);
    this.finalize();
  }

  protected poseIdle(t: number): void {
    this.body.py = Math.sin(t) * 0.014;
    this.body.s = 1 + Math.sin(t) * 0.008;
    this.head.ry = Math.sin(t * 0.33) * 0.28;
    this.head.rz = Math.sin(t * 6) * 0.03 * smooth01(Math.sin(t * 0.47) * 4 - 3); // ear-ish flick
    if (this.tail) this.tail.ry = Math.sin(t * 0.8) * 0.3;
    this.tail2.ry = Math.sin(t * 0.8 + 0.9) * 0.4;
    this.jaw.rx = 0.04 + Math.sin(t) * 0.02;
  }

  protected poseRun(speed: number): void {
    this.quadGait(speed, 0.8, 0.055);
    const k = Math.min(1, speed / this.def.speed);
    this.neck.rx = 0.12 * k;
    this.head.rx = -0.15 * k;
    if (this.tail) {
      this.tail.rx = -0.7 * k;
      this.tail.ry = Math.sin(this.gaitPhase) * 0.15 * k;
    }
    this.tail2.ry = Math.sin(this.gaitPhase + 1) * 0.25 * k;
  }

  protected poseAttack(n: 1 | 2 | 3, u: number): void {
    const s = attackCurve(u);
    if (n === 1 || n === 2) {
      const side = n === 1 ? 1 : -1; // FR then FL
      const paw = this.legs[n === 1 ? 1 : 0];
      paw.rx = -1.5 * s;
      paw.rz = -0.45 * s * side;
      this.body.ry = 0.28 * s * side;
      this.body.rx = -0.08 * Math.abs(s);
      this.neck.ry = -0.15 * s * side;
      this.legs[n === 1 ? 0 : 1].rx = 0.25 * Math.abs(s);
    } else {
      // Maul Bite: lunge + jaw snap shut exactly at the impact instant.
      const open = ramp(u, 0.06, 0.34);
      const close = ramp(u, 0.42, IMPACT);
      this.jaw.rx = 0.95 * open * (1 - close);
      this.neck.rx = 0.4 * s;
      this.head.rx = 0.3 * s;
      this.body.pz = 0.3 * Math.max(0, s);
      this.body.rx = 0.12 * s;
      this.legs[0].rx = -0.4 * Math.max(0, s);
      this.legs[1].rx = -0.4 * Math.max(0, s);
    }
    if (this.tail) this.tail.ry = -0.3 * s;
  }

  protected poseSpecial(u: number, _state: FighterState): void {
    // Pounce: crouch → stretched leap → landing crunch at 55%.
    const crouch = smooth01(ramp(u, 0, 0.26)) * (1 - smooth01(ramp(u, 0.28, 0.4)));
    const air = smooth01(ramp(u, 0.3, 0.44)) * (1 - smooth01(ramp(u, IMPACT, 0.72)));
    const land = impactPulse(u, 0.08);
    this.body.py = -0.3 * crouch + 0.18 * air - 0.22 * land;
    this.body.rx = 0.15 * crouch - 0.3 * air + 0.18 * land;
    this.legs[0].rx = 0.7 * crouch - 1.25 * air + 0.5 * land;
    this.legs[1].rx = 0.7 * crouch - 1.25 * air + 0.5 * land;
    this.legs[2].rx = -0.5 * crouch + 1.0 * air;
    this.legs[3].rx = -0.5 * crouch + 1.0 * air;
    this.neck.rx = -0.2 * air + 0.25 * land;
    this.jaw.rx = 0.5 * air * (1 - land);
    if (this.tail) this.tail.rx = -0.8 * air;
  }

  protected poseUltimate(u: number, _state: FighterState): void {
    // King's Roar: rear up, mane flared, jaw wide, trembling with the roar.
    const k = smooth01(ramp(u, 0.04, 0.28)) * (1 - smooth01(ramp(u, 0.78, 1)));
    this.body.rx = -0.85 * k;
    this.body.py = 0.14 * k;
    this.legs[0].rx = -1.35 * k;
    this.legs[1].rx = -1.15 * k;
    this.legs[2].rx = 0.55 * k;
    this.legs[3].rx = 0.55 * k;
    this.neck.rx = -0.2 * k;
    this.head.rx = -0.45 * k;
    this.jaw.rx = k * (0.85 + 0.08 * Math.sin(this.timePhase * 34));
    this.mane.s = 1 + 0.3 * k;
    if (this.tail) this.tail.rx = -0.5 * k;
  }

  protected poseBlock(t: number): void {
    this.body.py = -0.12;
    this.body.rx = 0.08 + Math.sin(t * 2) * 0.015;
    this.legs[1].rx = -1.45;
    this.legs[1].rz = -0.3;
    this.legs[0].rx = 0.2;
    this.neck.rx = 0.18;
    this.head.rx = 0.22;
    if (this.tail) this.tail.rx = 0.3;
  }
}
