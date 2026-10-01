/**
 * LION — "The King" (§8 #1). Mane silhouette, paw-swipe combo ending in the
 * Maul Bite, Pounce leap special, Royal Hunt ultimate (coil → bounding pounce → pin →
 * four claw/bite strikes → rearing roar; poses in ultPose/lion.ts).
 *
 * v1.1: solid muscular legs with paws + claws, a full mane of tufts wrapped
 * around the head and neck (plus chest ruff), a real face (amber eyes with
 * pupils/glints, brow, muzzle pads, nose, fangs), ear tufts and tail tuft.
 */

import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, impactPulse, ramp, smooth01, IMPACT } from './Animator';
import { LC, LION_CH_NAMES, sampleLionUlt } from './ultPose/lion';
import {
  makeMat,
  mesh,
  part,
  pivot,
  sphGeo,
  capGeo,
  cylGeo,
  coneGeo,
  torusGeo,
  lumpGeo,
  solidLeg,
  eye,
  teeth,
  noTone,
  noOutline,
  shade,
  mixColor,
} from './parts';

export class LionRig extends BaseRig {
  private readonly neck: Joint;
  private readonly jaw: Joint;
  private readonly mane: Joint;
  private readonly tail2: Joint;
  /** Scratch for the Royal Hunt pose channels (no per-frame allocation). */
  private readonly ultV = new Float64Array(LION_CH_NAMES.length);

  constructor() {
    super(ANIMALS.lion);
    this.hipDrop = 0.55;
    this.strideRate = 0.34;
    this.stepScale = 0.75;
    this.slams = [{ action: 'special', at: IMPACT, radius: 1.6, kind: 'ring', forward: 0.9 }];
    const p = this.pal;
    const mBody = makeMat(p.accent);
    const mDark = makeMat(p.dark);
    const maneCol = mixColor(0x6b3a17, p.darker, 0.35);
    const mMane = makeMat(maneCol);
    const mMane2 = makeMat(shade(maneCol, -0.22));
    const mManeTip = makeMat(mixColor(maneCol, p.accent, 0.45));
    const mBelly = makeMat(mixColor(p.belly, 0xf2e2c2, 0.35));
    const mMuzzle = makeMat(0xf3e6cc);
    const mNose = makeMat(0x4a2c24);
    const mClaw = makeMat(0x2a211b);
    const mTooth = makeMat(0xf6f0e0);
    const mMouth = makeMat(0x5a1e1a);

    const bodyN = pivot(0, 0.92, 0);
    this.bodyRoot.add(bodyN);
    // Torso: long capsule + deep chest + round haunch; lighter belly.
    const torso = part(capGeo(0.32, 0.78, 8), mBody, 0, 0.03, -0.04, 1, 1, 0.98, Math.PI / 2);
    bodyN.add(torso);
    bodyN.add(part(sphGeo(0.37, 9, 6), mBody, 0, 0.04, 0.34, 1, 1.02, 1.05)); // chest
    bodyN.add(part(sphGeo(0.34, 9, 6), mBody, 0, 0.06, -0.42, 1.02, 0.98, 1)); // haunch
    bodyN.add(part(sphGeo(0.3, 8, 5), mBelly, 0, -0.14, -0.02, 0.9, 0.55, 2.1)); // belly
    bodyN.add(part(sphGeo(0.12, 6, 4), mDark, 0, 0.3, -0.25, 1.6, 0.35, 2.6)); // darker spine line

    // Legs (FL, FR, BL, BR): solid, muscular, with paws + claws.
    const mkLeg = (x: number, z: number, back: boolean): Joint => {
      const g = solidLeg({
        mat: mBody,
        lowMat: mBody,
        clawMat: mClaw,
        len: 0.92,
        rTop: back ? 0.19 : 0.16,
        rBot: 0.078,
        foot: 'paw',
        toes: 3,
        bend: back ? -0.18 : 0.1,
      });
      g.position.set(x, 0, z);
      bodyN.add(g);
      return this.joint(g);
    };

    // Neck, mane, head, jaw.
    const neckN = pivot(0, 0.2, 0.52);
    bodyN.add(neckN);
    neckN.add(part(cylGeo(0.2, 0.26, 0.42, 8), mBody, 0, 0.02, 0.02, 1, 1, 1, 1.0)); // neck
    const maneN = pivot(0, 0.1, 0.12);
    neckN.add(maneN);
    // Mane: a thick collar ring framing the face, a fringe of pointed tufts,
    // a back layer over the neck and a chest ruff — all hugging the head.
    maneN.add(part(sphGeo(0.33, 9, 6), mMane2, 0, 0.06, -0.08, 1.1, 1.15, 0.95)); // core
    maneN.add(part(torusGeo(0.25, 0.13, 5, 12), mMane, 0, 0.09, 0.1, 1, 1.06, 1.25)); // collar
    const ringN = 10;
    for (let i = 0; i < ringN; i++) {
      const a = (i / ringN) * Math.PI * 2 + 0.3;
      const tuft = part(
        coneGeo(0.085, 0.22, 4),
        i % 2 === 0 ? mManeTip : mMane2,
        Math.cos(a) * 0.37,
        0.09 + Math.sin(a) * 0.39,
        0.03,
        1,
        1,
        0.7,
        -0.35,
        0,
        a - Math.PI / 2,
      );
      maneN.add(tuft);
    }
    maneN.add(part(sphGeo(0.2, 7, 5), mMane, 0, 0.12, -0.3, 1.25, 1, 1.2)); // over the neck
    maneN.add(part(sphGeo(0.17, 7, 5), mMane, 0, -0.24, 0.06, 1.25, 1.35, 0.9)); // chest ruff
    maneN.add(part(coneGeo(0.12, 0.26, 5), mMane2, 0, -0.42, 0.05, 1, 1, 0.8, Math.PI));

    const headN = pivot(0, 0.16, 0.3);
    neckN.add(headN);
    headN.add(part(sphGeo(0.2, 9, 6), mBody, 0, 0.03, 0.08, 1.05, 0.95, 1.05)); // skull
    headN.add(part(sphGeo(0.14, 8, 5), mBody, 0, -0.03, 0.27, 1.05, 0.82, 1.15)); // snout
    headN.add(part(sphGeo(0.08, 6, 4), mDark, 0, 0.1, 0.23, 2.1, 0.5, 0.9)); // brow ridge
    headN.add(part(sphGeo(0.065, 6, 4), mMuzzle, -0.055, -0.07, 0.37, 1, 0.85, 1)); // whisker pads
    headN.add(part(sphGeo(0.065, 6, 4), mMuzzle, 0.055, -0.07, 0.37, 1, 0.85, 1));
    headN.add(noTone(part(sphGeo(0.05, 6, 4), mNose, 0, 0.0, 0.42, 1.2, 0.75, 0.8))); // nose
    headN.add(noOutline(part(sphGeo(0.035, 5, 3), mMouth, 0, -0.1, 0.36, 1.6, 0.4, 0.6)));
    // Eyes (amber, round pupils, glint).
    const eL = eye({ r: 0.038, iris: 0xe0a53a, side: -1, lateral: 0.3 });
    eL.position.set(-0.085, 0.07, 0.25);
    const eR = eye({ r: 0.038, iris: 0xe0a53a, side: 1, lateral: 0.3 });
    eR.position.set(0.085, 0.07, 0.25);
    headN.add(eL, eR);
    // Round ears with a lighter inner.
    for (const sx of [-1, 1]) {
      headN.add(part(sphGeo(0.065, 6, 4), mDark, sx * 0.14, 0.2, 0.02, 1, 1, 0.45));
      headN.add(noOutline(part(sphGeo(0.04, 5, 3), mMuzzle, sx * 0.14, 0.195, 0.045, 1, 1, 0.3)));
    }
    headN.add(teeth(mTooth, 2, 0.1, 0.07, 0, -0.1, 0.39)); // upper fangs
    const jawN = pivot(0, -0.1, 0.14);
    headN.add(jawN);
    jawN.add(part(sphGeo(0.1, 8, 5), mMuzzle, 0, -0.025, 0.17, 1, 0.5, 1.5)); // lower jaw
    jawN.add(teeth(mTooth, 2, 0.08, 0.05, 0, 0.01, 0.28, true));

    // Tail: two segments + dark tuft.
    const tail1N = pivot(0, 0.14, -0.52);
    tail1N.rotation.x = 1.25;
    bodyN.add(tail1N);
    tail1N.add(mesh(cylGeo(0.05, 0.04, 0.48, 6), mBody, 0, -0.24, 0));
    const tail2N = pivot(0, -0.46, 0);
    tail2N.rotation.x = 0.4;
    tail1N.add(tail2N);
    tail2N.add(mesh(cylGeo(0.036, 0.03, 0.34, 6), mBody, 0, -0.17, 0));
    tail2N.add(part(lumpGeo(0.08), mMane2, 0, -0.37, 0, 1, 1.4, 1));

    this.body = this.joint(bodyN);
    this.legs = [mkLeg(-0.27, 0.42, false), mkLeg(0.27, 0.42, false), mkLeg(-0.26, -0.42, true), mkLeg(0.26, -0.42, true)];
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

  /**
   * Royal Hunt: a keyframed, cubic-eased timeline driven only by `actionT` + `ultPhase`/`ultStage`
   * (see ultPose/lion.ts): coil → pounce → pin → 4 strikes → roar → settle (or a whiff skid).
   */
  protected poseUltimate(_u: number, state: FighterState): void {
    const v = this.ultV;
    sampleLionUlt(state.actionT, state.ultPhase, state.ultStage, v);
    this.body.py = v[LC.bodyPy];
    this.body.pz = v[LC.bodyPz];
    this.body.rx = v[LC.bodyRx];
    this.body.ry = v[LC.bodyRy];
    this.body.rz = v[LC.bodyRz];
    this.legs[0].rx = v[LC.l0Rx];
    this.legs[0].rz = v[LC.l0Rz];
    this.legs[1].rx = v[LC.l1Rx];
    this.legs[1].rz = v[LC.l1Rz];
    this.legs[2].rx = v[LC.l2Rx];
    this.legs[2].rz = v[LC.l2Rz];
    this.legs[3].rx = v[LC.l3Rx];
    this.legs[3].rz = v[LC.l3Rz];
    this.neck.rx = v[LC.neckRx];
    this.neck.ry = v[LC.neckRy];
    this.head.rx = v[LC.headRx];
    this.head.ry = v[LC.headRy];
    this.head.rz = v[LC.headRz];
    this.jaw.rx = v[LC.jawRx];
    this.mane.s = v[LC.maneS];
    if (this.tail) {
      this.tail.rx = v[LC.tailRx];
      this.tail.ry = v[LC.tailRy];
    }
    this.tail2.rx = v[LC.tail2Rx];
    this.tail2.ry = v[LC.tail2Ry];
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
