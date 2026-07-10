/**
 * PANTHER — "The Shadow" (§8 #7). Sleek, low, long-tailed cat with glowing
 * green eyes. Rapid claw combo with a lunge bite, Shadow Dash special, and the
 * Night Prowl stealth slink (transparency applied centrally from the buff).
 */

import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, ramp, smooth01 } from './Animator';
import * as THREE from 'three';
import { makeMat, mesh, pivot, boxGeo, sphGeo, coneGeo, capGeo, cylGeo, leg } from './parts';

export class PantherRig extends BaseRig {
  private readonly neck: Joint;
  private readonly jaw: Joint;
  private readonly tail2: Joint;

  constructor() {
    super(ANIMALS.panther);
    this.hipDrop = 0.48;
    this.strideRate = 0.38;
    const p = this.pal;
    const mBody = makeMat(p.accent);
    const mDark = makeMat(p.dark);
    const mBelly = makeMat(p.darker);
    const mBlack = makeMat(p.black);
    // Glowing predator eyes.
    const mEye = new THREE.MeshStandardMaterial({
      color: 0x8fe86a,
      emissive: 0x59c23f,
      emissiveIntensity: 0.9,
      roughness: 0.5,
      flatShading: true,
    });

    const bodyN = pivot(0, 0.78, 0);
    this.bodyRoot.add(bodyN);
    const torso = mesh(capGeo(0.26, 0.9, 7), mBody, 0, 0, -0.05);
    torso.rotation.x = Math.PI / 2;
    bodyN.add(torso);
    bodyN.add(mesh(sphGeo(0.27, 7, 5), mBody, 0, 0.03, 0.42)); // chest
    bodyN.add(mesh(boxGeo(0.34, 0.18, 0.6), mBelly, 0, -0.2, 0));

    const mkLeg = (x: number, z: number): Joint => {
      const g = leg(mDark, 0.085, 0.065, 0.78, mBody);
      g.position.set(x, 0, z);
      bodyN.add(g);
      return this.joint(g);
    };

    // Slim neck and rounded head.
    const neckN = pivot(0, 0.14, 0.55);
    bodyN.add(neckN);
    neckN.add(mesh(cylGeo(0.13, 0.16, 0.24, 6), mBody, 0, 0.06, 0.06));
    const headN = pivot(0, 0.2, 0.18);
    neckN.add(headN);
    headN.add(mesh(sphGeo(0.17, 7, 5), mBody, 0, 0.02, 0.04));
    headN.add(mesh(boxGeo(0.13, 0.1, 0.16), mDark, 0, -0.04, 0.2)); // muzzle
    headN.add(mesh(boxGeo(0.05, 0.03, 0.04), mBlack, 0, 0, 0.29)); // nose
    const earL = mesh(coneGeo(0.05, 0.11, 4), mBody, -0.1, 0.16, -0.02);
    const earR = mesh(coneGeo(0.05, 0.11, 4), mBody, 0.1, 0.16, -0.02);
    headN.add(earL, earR);
    headN.add(mesh(sphGeo(0.032, 5, 4), mEye, -0.08, 0.06, 0.15));
    headN.add(mesh(sphGeo(0.032, 5, 4), mEye, 0.08, 0.06, 0.15));
    const jawN = pivot(0, -0.08, 0.08);
    headN.add(jawN);
    jawN.add(mesh(boxGeo(0.1, 0.05, 0.14), mDark, 0, -0.01, 0.12));

    // Long expressive tail.
    const tail1N = pivot(0, 0.1, -0.55);
    tail1N.rotation.x = 1.1;
    bodyN.add(tail1N);
    tail1N.add(mesh(cylGeo(0.04, 0.032, 0.5, 5), mBody, 0, -0.25, 0));
    const tail2N = pivot(0, -0.5, 0);
    tail2N.rotation.x = 0.55;
    tail1N.add(tail2N);
    tail2N.add(mesh(cylGeo(0.03, 0.022, 0.45, 5), mBody, 0, -0.22, 0));
    tail2N.add(mesh(sphGeo(0.045, 5, 4), mBlack, 0, -0.46, 0));

    this.body = this.joint(bodyN);
    this.legs = [mkLeg(-0.24, 0.46), mkLeg(0.24, 0.46), mkLeg(-0.24, -0.44), mkLeg(0.24, -0.44)];
    this.neck = this.joint(neckN);
    this.head = this.joint(headN);
    this.jaw = this.joint(jawN);
    this.tail = this.joint(tail1N);
    this.tail2 = this.joint(tail2N);
    this.finalize();
  }

  protected poseIdle(t: number): void {
    this.body.py = Math.sin(t) * 0.012;
    this.body.s = 1 + Math.sin(t) * 0.008;
    this.head.ry = Math.sin(t * 0.45) * 0.35;
    this.head.rz = Math.sin(t * 5.3) * 0.03 * smooth01(Math.sin(t * 0.31) * 4 - 3);
    if (this.tail) this.tail.ry = Math.sin(t * 1.1) * 0.35;
    this.tail2.ry = Math.sin(t * 1.1 + 1.1) * 0.5; // restless tail tip
    this.tail2.rx = Math.sin(t * 0.7) * 0.2;
  }

  protected poseRun(speed: number): void {
    this.quadGait(speed, 0.95, 0.07); // big bounding stride
    const k = Math.min(1, speed / this.def.speed);
    this.body.py += -0.06 * k; // stays low
    this.neck.rx = 0.15 * k;
    this.head.rx = -0.2 * k;
    if (this.tail) {
      this.tail.rx = -0.9 * k; // tail streams out behind
      this.tail.ry = Math.sin(this.gaitPhase) * 0.12 * k;
    }
    this.tail2.rx = -0.3 * k;
  }

  protected poseAttack(n: 1 | 2 | 3, u: number): void {
    const s = attackCurve(u);
    if (n === 1 || n === 2) {
      // Blinding-fast alternating claw rakes.
      const side = n === 1 ? 1 : -1;
      const paw = this.legs[n === 1 ? 1 : 0];
      paw.rx = -1.7 * s;
      paw.rz = -0.35 * s * side;
      this.body.ry = 0.22 * s * side;
      this.body.py = -0.04 * Math.abs(s);
      this.neck.ry = -0.12 * s * side;
    } else {
      // Lunge bite: whole body springs, jaws close at 55%.
      const open = ramp(u, 0.05, 0.32);
      const close = ramp(u, 0.42, 0.55);
      this.jaw.rx = 0.8 * open * (1 - close);
      this.body.pz = 0.35 * Math.max(0, s);
      this.body.rx = 0.14 * s;
      this.neck.rx = 0.3 * s;
      this.head.rx = 0.2 * s;
      this.legs[0].rx = -0.5 * Math.max(0, s);
      this.legs[1].rx = -0.5 * Math.max(0, s);
    }
    if (this.tail) this.tail.ry = -0.25 * s;
  }

  protected poseSpecial(u: number, _state: FighterState): void {
    // Shadow Dash: full-stretch phantom sprint through the target.
    const k = smooth01(ramp(u, 0, 0.2)) * (1 - smooth01(ramp(u, 0.8, 1)));
    this.body.py = -0.18 * k;
    this.body.rx = 0.05 * k;
    this.legs[0].rx = -1.3 * k;
    this.legs[1].rx = -1.3 * k;
    this.legs[2].rx = 1.2 * k;
    this.legs[3].rx = 1.2 * k;
    this.neck.rx = 0.25 * k;
    this.head.rx = -0.25 * k;
    if (this.tail) this.tail.rx = -1.0 * k;
    this.tail2.rx = -0.4 * k;
  }

  protected poseUltimate(u: number, _state: FighterState): void {
    // Night Prowl: melt into a low hunting slink (stealth fade is central).
    const k = smooth01(ramp(u, 0, 0.3));
    this.body.py = -0.22 * k;
    this.body.rx = 0.04 * k;
    const g = this.timePhase * 5;
    for (let i = 0; i < 4; i++) {
      this.legs[i].rx = Math.sin(g + (i === 0 || i === 3 ? 0 : Math.PI)) * 0.3 * k;
    }
    this.neck.rx = 0.3 * k;
    this.head.rx = -0.3 * k;
    this.head.ry = Math.sin(this.timePhase * 1.7) * 0.2 * k;
    if (this.tail) {
      this.tail.rx = 0.4 * k; // tail low
      this.tail.ry = Math.sin(this.timePhase * 2.3) * 0.2 * k;
    }
  }

  protected poseBlock(t: number): void {
    // Coiled low guard, one paw raised to parry (perfect-block flavor).
    this.body.py = -0.16;
    this.body.rx = 0.06 + Math.sin(t * 2.4) * 0.012;
    this.legs[1].rx = -1.5;
    this.legs[1].rz = -0.25;
    this.legs[0].rx = 0.3;
    this.neck.rx = 0.2;
    this.head.rx = 0.12;
    if (this.tail) this.tail.ry = Math.sin(t * 3) * 0.2;
  }
}
