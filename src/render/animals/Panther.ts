/**
 * PANTHER — "The Shadow" (§8 #7). Sleek, low, long-tailed cat with glowing
 * green eyes. Rapid claw combo with a lunge bite, Shadow Dash special, and the
 * Shadow Execution ultimate (melt into shadow → 5 distinct slash poses, one per blink →
 * two-paw execute finisher → stalking recovery; poses in ultPose/panther.ts; the
 * transparency is the shared stealth buff the sim applies).
 *
 * v1.1: glossy black coat with a violet sheen on the back and faint ghost
 * rosettes, lean muscular legs with paws and claws, a compact cat head with
 * glowing (bloom) slit-pupil eyes, whisker pads, nose, fangs and pointed ears.
 */

import * as THREE from 'three';
import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, ramp, smooth01 } from './Animator';
import { PC, PANTHER_CH_NAMES, samplePantherUlt } from './ultPose/panther';
import {
  makeMat,
  mesh,
  part,
  pivot,
  sphGeo,
  coneGeo,
  capGeo,
  cylGeo,
  solidLeg,
  eye,
  teeth,
  noTone,
  noOutline,
  paint,
  cellular,
  mixColor,
  shade,
} from './parts';

export class PantherRig extends BaseRig {
  private readonly neck: Joint;
  private readonly jaw: Joint;
  private readonly tail2: Joint;
  /** Scratch for the Shadow Execution pose channels (no per-frame allocation). */
  private readonly ultV = new Float64Array(PANTHER_CH_NAMES.length);

  constructor() {
    super(ANIMALS.panther);
    this.hipDrop = 0.48;
    this.strideRate = 0.38;
    this.stepScale = 0.45;
    // Negative back tone = a glossy highlight on the upper coat (sheen).
    this.toneBack = -0.3;
    this.toneBelly = 0.05;
    this.slams = [{ action: 'special', at: 0.25, radius: 1.1, kind: 'ring', forward: 0 }];
    const p = this.pal;
    const coat = mixColor(p.darker, 0x1a1522, 0.35);
    const mBody = makeMat(coat);
    const mDark = makeMat(shade(coat, -0.25));
    const mMuzzle = makeMat(mixColor(coat, 0x4a4250, 0.35));
    const mNose = makeMat(0x0d0b10);
    const mClaw = makeMat(0xd8d2c6);
    const mTooth = makeMat(0xf2ece0);
    const mInnerEar = makeMat(0x5a3f58);

    const cell: [number, number] = [0, 0];
    const rosettes = (pp: THREE.Vector3, n: THREE.Vector3, c: THREE.Color): void => {
      cellular(pp.x, pp.y, pp.z, 0.12, cell);
      const ring = cell[0] > 0.035 && cell[0] < 0.055;
      if (ring && n.y > -0.3) c.multiplyScalar(0.62);
    };

    const bodyN = pivot(0, 0.78, 0);
    this.bodyRoot.add(bodyN);
    bodyN.add(paint(part(capGeo(0.25, 0.9, 8), mBody, 0, 0, -0.05, 1, 1, 0.95, Math.PI / 2), rosettes));
    bodyN.add(paint(part(sphGeo(0.27, 9, 6), mBody, 0, 0.03, 0.42, 1, 1.02, 1.0), rosettes)); // chest
    bodyN.add(paint(part(sphGeo(0.25, 8, 6), mBody, 0, 0.04, -0.46, 1, 0.95, 1.0), rosettes)); // haunch
    bodyN.add(part(sphGeo(0.2, 7, 5), mDark, 0, -0.14, 0.02, 0.85, 0.5, 2.3)); // belly tuck

    const mkLeg = (x: number, z: number, back: boolean): Joint => {
      const g = solidLeg({
        mat: mBody,
        lowMat: mBody,
        clawMat: mClaw,
        len: 0.78,
        rTop: back ? 0.15 : 0.125,
        rBot: 0.058,
        foot: 'paw',
        toes: 3,
        bend: back ? -0.2 : 0.1,
      });
      g.position.set(x, 0, z);
      bodyN.add(g);
      return this.joint(g);
    };

    // Slim neck and rounded head.
    const neckN = pivot(0, 0.14, 0.55);
    bodyN.add(neckN);
    neckN.add(part(cylGeo(0.13, 0.17, 0.26, 7), mBody, 0, 0.06, 0.06, 1, 1, 1, 0.6));
    const headN = pivot(0, 0.2, 0.18);
    neckN.add(headN);
    headN.add(part(sphGeo(0.165, 9, 7), mBody, 0, 0.02, 0.04, 1.08, 0.92, 1.05)); // skull
    headN.add(part(sphGeo(0.1, 8, 5), mMuzzle, 0, -0.035, 0.18, 1.05, 0.78, 1.0)); // muzzle
    headN.add(part(sphGeo(0.045, 5, 4), mMuzzle, -0.04, -0.055, 0.25, 1, 0.8, 1)); // whisker pads
    headN.add(part(sphGeo(0.045, 5, 4), mMuzzle, 0.04, -0.055, 0.25, 1, 0.8, 1));
    headN.add(noTone(part(sphGeo(0.03, 5, 3), mNose, 0, -0.01, 0.28, 1.3, 0.8, 0.8)));
    for (const sx of [-1, 1]) {
      headN.add(part(coneGeo(0.055, 0.12, 4), mBody, sx * 0.1, 0.16, -0.02, 1, 1, 0.55, -0.15, 0, -sx * 0.25));
      headN.add(noOutline(part(coneGeo(0.032, 0.08, 4), mInnerEar, sx * 0.1, 0.155, 0.0, 1, 1, 0.3, -0.15, 0, -sx * 0.25)));
      const e = eye({ r: 0.033, iris: 0x9cff6a, side: sx, lateral: 0.3, slit: true, glowing: true });
      e.position.set(sx * 0.075, 0.055, 0.155);
      headN.add(e);
    }
    headN.add(teeth(mTooth, 2, 0.06, 0.05, 0, -0.07, 0.26));
    const jawN = pivot(0, -0.08, 0.08);
    headN.add(jawN);
    jawN.add(part(sphGeo(0.07, 7, 4), mMuzzle, 0, -0.012, 0.12, 1, 0.45, 1.5));
    jawN.add(teeth(mTooth, 2, 0.05, 0.035, 0, 0.0, 0.2, true));

    // Long expressive tail.
    const tail1N = pivot(0, 0.1, -0.55);
    tail1N.rotation.x = 1.1;
    bodyN.add(tail1N);
    tail1N.add(mesh(cylGeo(0.045, 0.034, 0.5, 6), mBody, 0, -0.25, 0));
    const tail2N = pivot(0, -0.5, 0);
    tail2N.rotation.x = 0.55;
    tail1N.add(tail2N);
    tail2N.add(mesh(cylGeo(0.034, 0.024, 0.45, 6), mBody, 0, -0.22, 0));
    tail2N.add(part(sphGeo(0.04, 5, 4), mDark, 0, -0.46, 0, 1, 1.3, 1));

    this.body = this.joint(bodyN);
    this.legs = [mkLeg(-0.22, 0.46, false), mkLeg(0.22, 0.46, false), mkLeg(-0.21, -0.44, true), mkLeg(0.21, -0.44, true)];
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

  /**
   * Shadow Execution: a keyframed, cubic-eased timeline driven only by `actionT` + `ultPhase`/`ultStage`
   * (see ultPose/panther.ts). The body teleports on each `blink`; the pose stays continuous across it.
   */
  protected poseUltimate(_u: number, state: FighterState): void {
    const v = this.ultV;
    samplePantherUlt(state.actionT, state.ultPhase, state.ultStage, v);
    this.body.py = v[PC.bodyPy];
    this.body.pz = v[PC.bodyPz];
    this.body.rx = v[PC.bodyRx];
    this.body.ry = v[PC.bodyRy];
    this.body.rz = v[PC.bodyRz];
    this.legs[0].rx = v[PC.l0Rx];
    this.legs[0].rz = v[PC.l0Rz];
    this.legs[1].rx = v[PC.l1Rx];
    this.legs[1].rz = v[PC.l1Rz];
    this.legs[2].rx = v[PC.l2Rx];
    this.legs[2].rz = v[PC.l2Rz];
    this.legs[3].rx = v[PC.l3Rx];
    this.legs[3].rz = v[PC.l3Rz];
    this.neck.rx = v[PC.neckRx];
    this.neck.ry = v[PC.neckRy];
    this.head.rx = v[PC.headRx];
    this.head.ry = v[PC.headRy];
    this.head.rz = v[PC.headRz];
    this.jaw.rx = v[PC.jawRx];
    if (this.tail) {
      this.tail.rx = v[PC.tailRx];
      this.tail.ry = v[PC.tailRy];
    }
    this.tail2.rx = v[PC.tail2Rx];
    this.tail2.ry = v[PC.tail2Ry];
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
