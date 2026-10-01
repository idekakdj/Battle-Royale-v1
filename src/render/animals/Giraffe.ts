/**
 * GIRAFFE — "The High Tower" (§8 #9). ~4 m tall: long legs, two-segment neck
 * with ossicones and coat patches. Neck-swing combo ending in Skull Hammer,
 * Thunder Kick special, and the Timber Fall neck-hammer ultimate (v1.3: whip the
 * neck back, tremble, then fell it onto the committed circle — keyframed from
 * `actionT` in ultPose/giraffe.ts; the legs shuffle with the creep).
 *
 * v1.1: reticulated coat (brown polygon patches split by cream lines, baked
 * per facet) over a sloping torso with shoulder hump, knobbly long legs on
 * black hooves, a dark mane ridge down the neck, a long head with big lashed
 * eyes, pale muzzle, nostrils, sideways ears and tufted ossicones.
 */

import * as THREE from 'three';
import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, impactPulse, ramp, smooth01, IMPACT } from './Animator';
import { GIRAFFE_CH, GIRAFFE_IMPACT_T, TC, sampleGiraffeUlt } from './ultPose/giraffe';
import {
  makeMat,
  mesh,
  part,
  pivot,
  boxGeo,
  sphGeo,
  coneGeo,
  cylGeo,
  capGeo,
  solidLeg,
  eye,
  noTone,
  noOutline,
  paint,
  cellular,
  hash3,
  col,
  mixColor,
} from './parts';

/** Diagonal quadruped gait offsets (FL, FR, BL, BR), as the shared gait. */
const GAIT_OFF = [0, Math.PI, Math.PI, 0];

export class GiraffeRig extends BaseRig {
  private readonly neck1: Joint;
  private readonly neck2: Joint;
  private readonly ultV = new Float64Array(GIRAFFE_CH.length);

  constructor() {
    super(ANIMALS.giraffe);
    this.hipDrop = 1.15;
    this.strideRate = 0.22;
    this.stepScale = 0.8;
    this.outlineScale = 1.1;
    this.toneBack = 0.12;
    this.toneBelly = 0.25;
    this.slams = [
      { action: 'special', at: IMPACT, radius: 1.8, kind: 'crack', forward: 1.2 },
      { action: 'attack3', at: IMPACT, radius: 1.4, kind: 'crack', forward: 2.6 },
    ];
    const p = this.pal;
    const cream = mixColor(0xf1e1b8, p.light, 0.25);
    const mBody = makeMat(p.accent);
    const mCream = makeMat(cream);
    const mMane = makeMat(0x6b3a18);
    const mHoof = makeMat(0x1d1712);
    const mTuft = makeMat(0x231a14);
    const mMuzzle = makeMat(0xd9bb8a);
    const mNose = makeMat(0x3a2a20);
    const mLash = makeMat(0x1a120c);

    const creamC = col(cream);
    const patchA = col(0x8f4f1f);
    const patchB = col(0xa9632a);
    const cell: [number, number] = [0, 0];
    const coat = (pp: THREE.Vector3, _n: THREE.Vector3, c: THREE.Color): void => {
      if (pp.y < 0.75) {
        c.copy(creamC); // pale lower legs
        return;
      }
      const s = pp.y > 2.15 ? 0.12 : pp.y < 1.25 ? 0.1 : 0.17;
      cellular(pp.x * 0.8, pp.y, pp.z, s, cell);
      if (cell[1] - cell[0] < s * 0.12) {
        c.copy(creamC);
      } else {
        const h = hash3(Math.floor(pp.x / s), Math.floor(pp.y / s), Math.floor(pp.z / s));
        c.copy(patchA).lerp(patchB, h);
      }
    };

    const bodyN = pivot(0, 1.62, 0);
    this.bodyRoot.add(bodyN);
    bodyN.add(paint(part(capGeo(0.34, 0.62, 9), mBody, 0, 0, -0.05, 1, 1, 1.02, Math.PI / 2 - 0.14), coat));
    bodyN.add(paint(part(sphGeo(0.38, 9, 6), mBody, 0, 0.1, 0.36, 1, 1.05, 1), coat)); // shoulder hump
    bodyN.add(paint(part(sphGeo(0.32, 9, 6), mBody, 0, -0.04, -0.46, 1, 0.95, 1), coat)); // rump
    bodyN.add(part(sphGeo(0.28, 8, 5), mCream, 0, -0.26, -0.05, 0.85, 0.5, 1.9)); // pale belly

    // Two-segment neck reaching ~4 m, then the small horned head.
    const neck1N = pivot(0, 0.4, 0.52);
    neck1N.rotation.x = -0.42;
    bodyN.add(neck1N);
    neck1N.add(paint(part(cylGeo(0.14, 0.2, 1.0, 9), mBody, 0, 0.47, 0), coat));
    const neck2N = pivot(0, 0.95, 0);
    neck2N.rotation.x = 0.12;
    neck1N.add(neck2N);
    neck2N.add(paint(part(cylGeo(0.1, 0.145, 0.95, 8), mBody, 0, 0.45, 0), coat));
    neck2N.add(part(sphGeo(0.1, 7, 4), mBody, 0, 0.93, 0)); // throat latch
    // Mane ridge down the back of the neck.
    for (let i = 0; i < 5; i++) {
      neck1N.add(part(boxGeo(0.04, 0.2, 0.07), mMane, 0, 0.12 + i * 0.19, -0.175 + i * 0.008));
      neck2N.add(part(boxGeo(0.035, 0.18, 0.06), mMane, 0, 0.08 + i * 0.17, -0.13 + i * 0.008));
    }
    const headN = pivot(0, 0.95, 0);
    headN.rotation.x = 0.85; // level the head off the raked neck
    neck2N.add(headN);
    headN.add(paint(part(sphGeo(0.12, 9, 6), mBody, 0, 0.03, 0.08, 0.88, 0.95, 1.35), coat)); // skull
    headN.add(part(sphGeo(0.09, 8, 5), mMuzzle, 0, -0.02, 0.29, 0.9, 0.85, 1.35)); // muzzle
    headN.add(noOutline(noTone(part(sphGeo(0.018, 4, 3), mNose, -0.035, 0.01, 0.4, 1, 0.6, 1))));
    headN.add(noOutline(noTone(part(sphGeo(0.018, 4, 3), mNose, 0.035, 0.01, 0.4, 1, 0.6, 1))));
    for (const sx of [-1, 1]) {
      const e = eye({ r: 0.036, iris: 0x2a1a10, side: sx, lateral: 0.8 });
      e.position.set(sx * 0.095, 0.07, 0.11);
      headN.add(e);
      headN.add(noOutline(part(boxGeo(0.02, 0.012, 0.06), mLash, sx * 0.112, 0.105, 0.11, 1, 1, 1, 0, 0, sx * 0.3)));
      // Sideways ears.
      headN.add(part(coneGeo(0.045, 0.16, 5), mBody, sx * 0.16, 0.09, -0.02, 1, 1, 0.55, 0, 0, -sx * (Math.PI / 2 - 0.25)));
    }
    // Ossicones with dark tufts.
    const ossL = pivot(-0.06, 0.14, 0.0);
    ossL.add(part(cylGeo(0.022, 0.028, 0.13, 6), mBody, 0, 0.06, 0));
    ossL.add(part(sphGeo(0.035, 6, 4), mTuft, 0, 0.14, 0));
    const ossR = pivot(0.06, 0.14, 0.0);
    ossR.add(part(cylGeo(0.022, 0.028, 0.13, 6), mBody, 0, 0.06, 0));
    ossR.add(part(sphGeo(0.035, 6, 4), mTuft, 0, 0.14, 0));
    headN.add(ossL, ossR);

    // Long knobbly legs on black hooves.
    const mkLeg = (x: number, z: number, back: boolean): Joint => {
      const g = solidLeg({
        mat: mBody,
        lowMat: mCream,
        clawMat: mHoof,
        len: 1.6,
        rTop: back ? 0.15 : 0.13,
        rBot: 0.065,
        foot: 'hoof',
        bend: back ? -0.08 : 0.05,
      });
      g.position.set(x, -0.02, z);
      bodyN.add(g);
      g.traverse((o) => {
        if (o instanceof THREE.Mesh && o.material !== mHoof) paint(o, coat);
      });
      return this.joint(g);
    };

    const tailN = pivot(0, 0.2, -0.65);
    tailN.rotation.x = 1.15;
    bodyN.add(tailN);
    tailN.add(mesh(cylGeo(0.03, 0.02, 0.7, 5), mBody, 0, -0.35, 0));
    tailN.add(part(coneGeo(0.06, 0.2, 5), mTuft, 0, -0.78, 0, 1, 1, 1, Math.PI));

    this.body = this.joint(bodyN);
    this.legs = [mkLeg(-0.26, 0.48, false), mkLeg(0.26, 0.48, false), mkLeg(-0.26, -0.5, true), mkLeg(0.26, -0.5, true)];
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

  /**
   * Timber Fall (v1.3): keyframed from `state.actionT` / `actionDur` (see ultPose/giraffe.ts) — the neck whipped
   * back and up, a trembling tension hold, the overhead slam with the forelegs buckling, a head bounce and the
   * rise (a whiff searches side to side). While the giraffe creeps in (`state.vel`) the legs shuffle in the
   * shared diagonal gait until the slam.
   */
  protected poseUltimate(_u: number, state: FighterState): void {
    const v = this.ultV;
    sampleGiraffeUlt(state.actionT, state.actionDur, v);
    this.body.py = v[TC.bodyPy];
    this.body.pz = v[TC.bodyPz];
    this.body.rx = v[TC.bodyRx];
    this.body.ry = v[TC.bodyRy];
    this.body.rz = v[TC.bodyRz];
    this.neck1.rx = v[TC.n1Rx];
    this.neck1.rz = v[TC.n1Rz];
    this.neck2.rx = v[TC.n2Rx];
    this.neck2.rz = v[TC.n2Rz];
    this.head.rx = v[TC.headRx];
    this.head.rz = v[TC.headRz];
    this.legs[0].rx = v[TC.lFRx];
    this.legs[1].rx = v[TC.lFRx];
    this.legs[2].rx = v[TC.lBRx];
    this.legs[3].rx = v[TC.lBRx];
    this.legs[0].rz = -v[TC.legRz];
    this.legs[1].rz = v[TC.legRz];
    this.legs[2].rz = v[TC.legRz] * 0.5;
    this.legs[3].rz = -v[TC.legRz] * 0.5;
    if (this.tail) this.tail.rx = v[TC.tailRx];
    // Creeping in: shuffle the legs with the stride until the slam lands (weight fades out into the slam).
    const speed = Math.hypot(state.vel.x, state.vel.z);
    if (speed > 0.15 && state.actionT < GIRAFFE_IMPACT_T) {
      const k = Math.min(1, speed / this.def.speed) * (1 - smooth01(ramp(state.actionT, GIRAFFE_IMPACT_T - 0.2, GIRAFFE_IMPACT_T)));
      for (let i = 0; i < 4; i++) this.legs[i].rx += Math.sin(this.gaitPhase + GAIT_OFF[i]) * 0.5 * k;
      this.body.py += Math.sin(this.gaitPhase * 2) * 0.03 * k;
    }
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
