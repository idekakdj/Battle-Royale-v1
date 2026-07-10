/**
 * MOLE — "The Undertaker" (§8 #10). Compact velvet teardrop with huge ivory
 * digging claws and a pink snout. Claw-swipe combo ending in Dirt Slinger,
 * Burrow special (mound handled by BaseRig; the special pose is the Uppercut
 * Eruption), and the Sinkhole ground-slam ultimate.
 */

import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, impactPulse, ramp, smooth01 } from './Animator';
import { makeMat, mesh, pivot, boxGeo, sphGeo, coneGeo, cylGeo } from './parts';

export class MoleRig extends BaseRig {
  private readonly armL: Joint;
  private readonly armR: Joint;
  private readonly snout: Joint;

  constructor() {
    super(ANIMALS.mole);
    this.hipDrop = 0.22;
    this.strideRate = 0.8; // frantic little scurry steps
    const p = this.pal;
    const mBody = makeMat(p.accent);
    const mDark = makeMat(p.dark);
    const mBelly = makeMat(p.belly);
    const mClaw = makeMat(p.bone);
    const mPink = makeMat(0xd98f7e);
    const mBlack = makeMat(p.eye);

    const bodyN = pivot(0, 0.36, 0);
    this.bodyRoot.add(bodyN);
    const blob = mesh(sphGeo(0.3, 8, 6), mBody, 0, 0, -0.02);
    blob.scale.set(1.0, 0.95, 1.3);
    bodyN.add(blob);
    const belly = mesh(sphGeo(0.26, 7, 5), mBelly, 0, -0.1, 0.02);
    belly.scale.set(0.9, 0.7, 1.2);
    bodyN.add(belly);

    // Head is mostly snout.
    const headN = pivot(0, 0.1, 0.3);
    bodyN.add(headN);
    headN.add(mesh(sphGeo(0.16, 6, 5), mBody, 0, 0, 0.02));
    const snoutN = pivot(0, 0, 0.12);
    headN.add(snoutN);
    const cone = mesh(coneGeo(0.1, 0.26, 6), mBody, 0, 0, 0.12);
    cone.rotation.x = Math.PI / 2;
    snoutN.add(cone);
    snoutN.add(mesh(sphGeo(0.045, 5, 4), mPink, 0, 0, 0.26));
    headN.add(mesh(sphGeo(0.02, 4, 3), mBlack, -0.07, 0.07, 0.1)); // near-blind pin eyes
    headN.add(mesh(sphGeo(0.02, 4, 3), mBlack, 0.07, 0.07, 0.1));

    // Massive shovel claws on stubby arms.
    const mkArm = (side: number): Joint => {
      const sh = pivot(0.27 * side, -0.02, 0.18);
      sh.rotation.z = 0.3 * side;
      bodyN.add(sh);
      sh.add(mesh(cylGeo(0.07, 0.06, 0.16, 5), mDark, 0, -0.08, 0));
      const paddle = mesh(boxGeo(0.16, 0.2, 0.1), mPink, 0, -0.22, 0.02);
      sh.add(paddle);
      for (let i = -1; i <= 1; i++) {
        const claw = mesh(coneGeo(0.028, 0.14, 4), mClaw, 0.05 * i, -0.34, 0.04);
        claw.rotation.x = Math.PI;
        sh.add(claw);
      }
      return this.joint(sh);
    };

    // Small hind feet.
    const mkLeg = (side: number): Joint => {
      const g = pivot(0.16 * side, -0.24, -0.16);
      bodyN.add(g);
      g.add(mesh(cylGeo(0.05, 0.045, 0.14, 5), mDark, 0, -0.07, 0));
      const foot = mesh(sphGeo(0.055, 5, 4), mPink, 0, -0.14, 0.03);
      foot.scale.set(1, 0.6, 1.4);
      g.add(foot);
      return this.joint(g);
    };

    // Thin naked tail.
    const tailN = pivot(0, 0.06, -0.38);
    tailN.rotation.x = 0.7;
    bodyN.add(tailN);
    tailN.add(mesh(cylGeo(0.02, 0.012, 0.22, 4), mPink, 0, -0.11, 0));

    this.body = this.joint(bodyN);
    this.head = this.joint(headN);
    this.snout = this.joint(snoutN);
    this.armL = mkArm(-1);
    this.armR = mkArm(1);
    this.legs = [this.armL, this.armR, mkLeg(-1), mkLeg(1)];
    this.tail = this.joint(tailN);
    this.finalize();
  }

  protected poseIdle(t: number): void {
    this.body.py = Math.sin(t * 1.3) * 0.012;
    this.body.s = 1 + Math.sin(t * 1.3) * 0.012;
    this.snout.rx = Math.sin(t * 7) * 0.08; // constant sniffing
    this.snout.ry = Math.sin(t * 4.3) * 0.06;
    this.head.ry = Math.sin(t * 0.5) * 0.25;
    this.armL.rx = Math.sin(t * 2.1) * 0.06;
    this.armR.rx = Math.sin(t * 2.1 + 2) * 0.06;
    if (this.tail) this.tail.ry = Math.sin(t * 2.7) * 0.3;
  }

  protected poseRun(speed: number): void {
    // Low scurry: rapid tiny steps, nose to the ground, claws paddling.
    const k = Math.min(1, speed / this.def.speed);
    const g = this.gaitPhase;
    this.armL.rx = Math.sin(g) * 0.7 * k;
    this.armR.rx = Math.sin(g + Math.PI) * 0.7 * k;
    this.legs[2].rx = Math.sin(g + Math.PI) * 0.6 * k;
    this.legs[3].rx = Math.sin(g) * 0.6 * k;
    this.body.py = -0.05 * k + Math.abs(Math.sin(g)) * 0.02 * k;
    this.body.rx = 0.12 * k;
    this.body.rz = Math.sin(g) * 0.05 * k;
    this.head.rx = -0.05 * k;
    this.snout.rx = Math.sin(g * 2) * 0.1 * k;
  }

  protected poseAttack(n: 1 | 2 | 3, u: number): void {
    const s = attackCurve(u);
    if (n === 1 || n === 2) {
      // Shovel-claw swipes.
      const side = n === 1 ? 1 : -1;
      const arm = n === 1 ? this.armR : this.armL;
      arm.rx = -1.6 * s;
      arm.rz = -0.5 * s * side;
      this.body.ry = 0.3 * s * side;
      this.body.rx = -0.05 * Math.abs(s);
      this.head.ry = -0.15 * s * side;
    } else {
      // Dirt Slinger: both claws scoop the ground and fling forward-up at 55%.
      const scoop = smooth01(ramp(u, 0, 0.36));
      const fling = impactPulse(u, 0.1);
      const rx = 1.0 * scoop * (1 - fling) - 2.1 * fling;
      this.armL.rx = rx;
      this.armR.rx = rx;
      this.body.rx = 0.3 * scoop * (1 - fling) - 0.35 * fling;
      this.body.py = -0.1 * scoop * (1 - fling) + 0.06 * fling;
      this.head.rx = 0.2 * scoop * (1 - fling) - 0.4 * fling;
    }
  }

  protected poseSpecial(u: number, state: FighterState): void {
    // Uppercut Eruption on emerge. While burrowT runs the body is hidden
    // (BaseRig shows the mound); this pose is the sink-in and the explosion.
    if (state.burrowT > 0) {
      // Sinking: dive nose-first.
      const k = smooth01(ramp(u, 0, 0.5));
      this.body.rx = 0.9 * k;
      this.body.py = -0.3 * k;
      this.armL.rx = 1.2 * k;
      this.armR.rx = 1.2 * k;
      return;
    }
    const crouch = smooth01(ramp(u, 0, 0.3)) * (1 - ramp(u, 0.34, 0.46));
    const erupt = impactPulse(u, 0.12);
    this.body.py = -0.28 * crouch + 0.3 * erupt;
    this.body.rx = 0.4 * crouch - 0.5 * erupt;
    const rx = 1.1 * crouch - 2.6 * erupt;
    this.armL.rx = rx;
    this.armR.rx = rx;
    this.armL.rz = 0.2 * erupt;
    this.armR.rz = -0.2 * erupt;
    this.head.rx = 0.3 * crouch - 0.5 * erupt;
    this.legs[2].rx = 0.5 * crouch - 0.6 * erupt;
    this.legs[3].rx = 0.5 * crouch - 0.6 * erupt;
  }

  protected poseUltimate(u: number, _state: FighterState): void {
    // Sinkhole: rear up tall, then drive both claws into the earth at 55%
    // and hold them buried while the zone collapses.
    const rear = smooth01(ramp(u, 0, 0.38));
    const slam = impactPulse(u, 0.1);
    const hold = ramp(u, 0.58, 0.7) * (1 - ramp(u, 0.88, 1));
    const down = Math.max(slam, hold);
    this.body.rx = -0.55 * rear * (1 - down) + 0.5 * down;
    this.body.py = 0.12 * rear * (1 - down) - 0.16 * down;
    const rx = -2.4 * rear * (1 - down) + 1.3 * down;
    this.armL.rx = rx;
    this.armR.rx = rx;
    this.head.rx = -0.4 * rear * (1 - down) + 0.3 * down;
    this.snout.rx = Math.sin(this.timePhase * 20) * 0.06 * down; // straining
    this.legs[2].rx = 0.4 * rear;
    this.legs[3].rx = 0.4 * rear;
  }

  protected poseBlock(t: number): void {
    // Claws crossed into a shield (stationary bonus flavor: dug in).
    this.body.py = -0.08;
    this.body.rx = 0.12 + Math.sin(t * 2.5) * 0.01;
    this.armL.rx = -0.9;
    this.armL.rz = 0.9;
    this.armR.rx = -0.9;
    this.armR.rz = -0.9;
    this.head.rx = 0.3;
    this.head.py = -0.03;
  }
}
