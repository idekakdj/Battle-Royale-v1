/**
 * GORILLA — "The Silverback" (§8 #2). Knuckle-walking hulk: huge shoulders and
 * arms, silver back panel. Hooks + Double-Fist Slam combo, Silverback Leap
 * slam special, chest-beating Primal Rampage ultimate.
 */

import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, impactPulse, ramp, smooth01, IMPACT } from './Animator';
import { makeMat, mesh, pivot, boxGeo, sphGeo, cylGeo } from './parts';

export class GorillaRig extends BaseRig {
  private readonly armL: Joint;
  private readonly armR: Joint;
  private readonly foreL: Joint;
  private readonly foreR: Joint;
  private readonly legL: Joint;
  private readonly legR: Joint;

  constructor() {
    super(ANIMALS.gorilla);
    this.hipDrop = 0.42;
    this.strideRate = 0.3;
    const p = this.pal;
    const mBody = makeMat(p.dark);
    const mDark = makeMat(p.darker);
    const mSilver = makeMat(p.light);
    const mSkin = makeMat(p.black);

    const bodyN = pivot(0, 0.78, 0);
    this.bodyRoot.add(bodyN);
    const torso = mesh(boxGeo(0.85, 0.8, 0.6), mBody, 0, 0.18, 0);
    torso.rotation.x = 0.22;
    bodyN.add(torso);
    const back = mesh(boxGeo(0.7, 0.5, 0.14), mSilver, 0, 0.32, -0.3);
    back.rotation.x = 0.22;
    bodyN.add(back); // the silver back
    bodyN.add(mesh(boxGeo(0.62, 0.42, 0.5), mBody, 0, -0.3, 0.02)); // pelvis
    bodyN.add(mesh(sphGeo(0.3, 7, 5), mBody, 0, 0.28, 0.3)); // chest

    // Head with brow ridge.
    const headN = pivot(0, 0.62, 0.3);
    bodyN.add(headN);
    headN.add(mesh(boxGeo(0.34, 0.32, 0.32), mBody, 0, 0.05, 0.05));
    headN.add(mesh(boxGeo(0.3, 0.09, 0.1), mDark, 0, 0.13, 0.22)); // brow
    headN.add(mesh(boxGeo(0.22, 0.16, 0.14), mSkin, 0, -0.06, 0.2)); // muzzle
    headN.add(mesh(sphGeo(0.11, 6, 4), mBody, 0, 0.24, -0.02)); // crest
    headN.add(mesh(sphGeo(0.03, 5, 4), mSkin, -0.09, 0.06, 0.22));
    headN.add(mesh(sphGeo(0.03, 5, 4), mSkin, 0.09, 0.06, 0.22));

    // Arms: shoulder + forearm joints, ending in fists (knuckle-walk rest).
    const mkArm = (side: number): [Joint, Joint] => {
      const sh = pivot(0.52 * side, 0.42, 0.12);
      sh.rotation.x = 0.35;
      bodyN.add(sh);
      sh.add(mesh(cylGeo(0.15, 0.12, 0.5, 6), mBody, 0, -0.25, 0));
      const el = pivot(0, -0.5, 0);
      el.rotation.x = -0.15;
      sh.add(el);
      el.add(mesh(cylGeo(0.12, 0.1, 0.55, 6), mDark, 0, -0.28, 0));
      el.add(mesh(sphGeo(0.16, 6, 5), mSkin, 0, -0.6, 0.02)); // fist
      return [this.joint(sh), this.joint(el)];
    };

    // Short legs.
    const mkLeg = (side: number): Joint => {
      const hip = pivot(0.26 * side, -0.42, 0);
      bodyN.add(hip);
      hip.add(mesh(cylGeo(0.14, 0.11, 0.38, 6), mDark, 0, -0.19, 0));
      hip.add(mesh(sphGeo(0.13, 6, 4), mSkin, 0, -0.38, 0.06));
      return this.joint(hip);
    };

    this.body = this.joint(bodyN);
    this.head = this.joint(headN);
    [this.armL, this.foreL] = mkArm(-1);
    [this.armR, this.foreR] = mkArm(1);
    this.legL = mkLeg(-1);
    this.legR = mkLeg(1);
    this.legs = [this.armL, this.armR, this.legL, this.legR];
    this.finalize();
  }

  protected poseIdle(t: number): void {
    this.body.py = Math.sin(t) * 0.02;
    this.body.s = 1 + Math.sin(t) * 0.01;
    this.head.ry = Math.sin(t * 0.4) * 0.3;
    this.head.rx = Math.sin(t * 0.9) * 0.05;
    this.armL.rz = Math.sin(t * 0.7) * 0.03;
    this.armR.rz = -Math.sin(t * 0.7) * 0.03;
  }

  protected poseRun(speed: number): void {
    // Knuckle-walk: arms and legs in diagonal pairs, torso rocking.
    const k = Math.min(1, speed / this.def.speed);
    const g = this.gaitPhase;
    this.armL.rx = Math.sin(g) * 0.75 * k;
    this.armR.rx = Math.sin(g + Math.PI) * 0.75 * k;
    this.legL.rx = Math.sin(g + Math.PI) * 0.6 * k;
    this.legR.rx = Math.sin(g) * 0.6 * k;
    this.foreL.rx = -0.15 * k;
    this.foreR.rx = -0.15 * k;
    this.body.rz = Math.sin(g) * 0.07 * k;
    this.body.py = Math.abs(Math.sin(g)) * 0.06 * k;
    this.body.rx = 0.1 * k;
    this.head.rx = -0.1 * k;
  }

  protected poseAttack(n: 1 | 2 | 3, u: number): void {
    const s = attackCurve(u);
    if (n === 1 || n === 2) {
      // Wide hooks, alternating arms.
      const arm = n === 1 ? this.armR : this.armL;
      const fore = n === 1 ? this.foreR : this.foreL;
      const side = n === 1 ? 1 : -1;
      arm.rx = -1.35 * s;
      arm.ry = -0.7 * s * side;
      fore.rx = -0.6 * Math.abs(s);
      this.body.ry = 0.35 * s * side;
      this.body.rx = -0.06 * Math.abs(s);
      this.head.ry = -0.2 * s * side;
    } else {
      // Double-Fist Slam: both arms overhead, crashing down at 55%.
      const raise = smooth01(ramp(u, 0, 0.38));
      const slam = impactPulse(u, 0.1);
      const rx = -2.3 * raise * (1 - slam) + 0.5 * slam;
      this.armL.rx = rx;
      this.armR.rx = rx;
      this.foreL.rx = -0.5 * raise * (1 - slam);
      this.foreR.rx = -0.5 * raise * (1 - slam);
      this.body.rx = -0.28 * raise * (1 - slam) + 0.3 * slam;
      this.body.py = 0.1 * raise - 0.16 * slam;
      this.head.rx = 0.25 * slam;
    }
  }

  protected poseSpecial(u: number, _state: FighterState): void {
    // Silverback Leap: crouch, sail, and a two-fisted slam landing at 55%.
    const crouch = smooth01(ramp(u, 0, 0.24)) * (1 - smooth01(ramp(u, 0.26, 0.38)));
    const air = smooth01(ramp(u, 0.28, 0.42)) * (1 - smooth01(ramp(u, 0.5, 0.6)));
    const slam = impactPulse(u, 0.09);
    this.body.py = -0.26 * crouch + 0.2 * air - 0.2 * slam;
    this.body.rx = 0.15 * crouch - 0.2 * air + 0.3 * slam;
    const armRx = 0.4 * crouch - 2.2 * air + 0.6 * slam;
    this.armL.rx = armRx;
    this.armR.rx = armRx;
    this.legL.rx = 0.8 * crouch - 0.7 * air;
    this.legR.rx = 0.8 * crouch - 0.7 * air;
    this.head.rx = -0.2 * air + 0.2 * slam;
  }

  protected poseUltimate(u: number, _state: FighterState): void {
    // Primal Rampage: rear up and drum the chest, alternating fists.
    const k = smooth01(ramp(u, 0, 0.15)) * (1 - smooth01(ramp(u, 0.85, 1)));
    const beat = this.timePhase * 16;
    this.body.rx = -0.45 * k;
    this.body.py = 0.1 * k;
    this.head.rx = -0.3 * k;
    this.head.ry = Math.sin(beat * 0.5) * 0.1 * k;
    const bL = Math.max(0, Math.sin(beat));
    const bR = Math.max(0, Math.sin(beat + Math.PI));
    this.armL.rx = (-1.3 + 0.5 * bL) * k;
    this.armL.ry = 0.5 * k;
    this.foreL.rx = (-1.4 + 0.6 * bL) * k;
    this.armR.rx = (-1.3 + 0.5 * bR) * k;
    this.armR.ry = -0.5 * k;
    this.foreR.rx = (-1.4 + 0.6 * bR) * k;
    this.legL.rx = 0.4 * k;
    this.legR.rx = 0.4 * k;
  }

  protected poseBlock(t: number): void {
    // Forearms crossed in front, hunkered.
    this.body.rx = 0.18;
    this.body.py = -0.1 + Math.sin(t * 2) * 0.01;
    this.armL.rx = -1.1;
    this.armL.ry = 0.55;
    this.foreL.rx = -1.5;
    this.armR.rx = -1.1;
    this.armR.ry = -0.55;
    this.foreR.rx = -1.5;
    this.head.rx = 0.25;
  }

  protected override poseGrab(_u: number, _state: FighterState): void {
    this.poseAttack(3, IMPACT);
  }
}
