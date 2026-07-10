/**
 * EAGLE — "The Sky Terror" (§8 #6). Wings + tail-fan silhouette, white head,
 * hooked beak. Talon rakes and Beak Pierce combo, Gale Burst wing-sweep
 * special, Death From Above soar-and-dive ultimate, and the glide (§7.8).
 */

import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, impactPulse, ramp, smooth01, IMPACT } from './Animator';
import { makeMat, mesh, pivot, boxGeo, sphGeo, coneGeo } from './parts';

// Rest fold angles (wings tucked against the body).
const FOLD_IN = 1.05;
const FOLD_OUT = 2.05;

export class EagleRig extends BaseRig {
  private readonly wingLIn: Joint;
  private readonly wingLOut: Joint;
  private readonly wingRIn: Joint;
  private readonly wingROut: Joint;
  private readonly tailFan: Joint;

  constructor() {
    super(ANIMALS.eagle);
    this.hipDrop = 0.35;
    this.strideRate = 0.5;
    const p = this.pal;
    const mBody = makeMat(p.dark);
    const mWing = makeMat(p.darker);
    const mWingLt = makeMat(p.accent);
    const mHead = makeMat(p.bone);
    const mBeak = makeMat(0xd8a020);
    const mLeg = makeMat(0xc9a23a);
    const mBlack = makeMat(p.eye);

    const bodyN = pivot(0, 0.72, 0);
    this.bodyRoot.add(bodyN);
    const torso = mesh(sphGeo(0.3, 8, 6), mBody, 0, 0, 0);
    torso.scale.set(0.85, 1.0, 1.35);
    torso.rotation.x = 0.45;
    bodyN.add(torso);
    bodyN.add(mesh(sphGeo(0.2, 7, 5), mWingLt, 0, -0.1, 0.22)); // chest

    // White head with a hooked golden beak.
    const headN = pivot(0, 0.4, 0.2);
    bodyN.add(headN);
    headN.add(mesh(sphGeo(0.16, 7, 5), mHead, 0, 0.02, 0));
    const beak = mesh(coneGeo(0.06, 0.2, 5), mBeak, 0, 0.02, 0.22);
    beak.rotation.x = Math.PI / 2;
    headN.add(beak);
    const hook = mesh(coneGeo(0.035, 0.08, 5), mBeak, 0, -0.04, 0.3);
    hook.rotation.x = Math.PI;
    headN.add(hook);
    headN.add(mesh(sphGeo(0.03, 5, 4), mBlack, -0.09, 0.07, 0.1));
    headN.add(mesh(sphGeo(0.03, 5, 4), mBlack, 0.09, 0.07, 0.1));

    // Tail fan.
    const tailN = pivot(0, -0.12, -0.32);
    tailN.rotation.x = -0.25;
    bodyN.add(tailN);
    tailN.add(mesh(boxGeo(0.3, 0.035, 0.5), mWing, 0, 0, -0.25));
    const fanL = mesh(boxGeo(0.16, 0.03, 0.42), mWing, -0.18, 0, -0.2);
    fanL.rotation.y = 0.35;
    tailN.add(fanL);
    const fanR = mesh(boxGeo(0.16, 0.03, 0.42), mWing, 0.18, 0, -0.2);
    fanR.rotation.y = -0.35;
    tailN.add(fanR);

    // Two-piece wings; rest pose folded.
    const mkWing = (side: number): [Joint, Joint] => {
      const inn = pivot(0.2 * side, 0.18, 0.02);
      inn.rotation.z = -FOLD_IN * side;
      bodyN.add(inn);
      inn.add(mesh(boxGeo(0.55, 0.05, 0.34), mWing, 0.27 * side, 0, -0.04));
      const out = pivot(0.55 * side, 0, 0);
      out.rotation.z = FOLD_OUT * side;
      inn.add(out);
      out.add(mesh(boxGeo(0.5, 0.04, 0.28), mWingLt, 0.24 * side, 0, -0.06));
      out.add(mesh(boxGeo(0.22, 0.035, 0.2), mWing, 0.55 * side, 0, -0.1)); // tip feathers
      return [this.joint(inn), this.joint(out)];
    };

    // Legs with talons.
    const mkLeg = (side: number): Joint => {
      const g = pivot(0.12 * side, -0.26, 0.06);
      bodyN.add(g);
      g.add(mesh(boxGeo(0.06, 0.3, 0.06), mLeg, 0, -0.15, 0));
      const foot = mesh(sphGeo(0.06, 5, 4), mLeg, 0, -0.32, 0.03);
      foot.scale.set(1, 0.6, 1.4);
      g.add(foot);
      for (let i = -1; i <= 1; i++) {
        const claw = mesh(coneGeo(0.02, 0.09, 4), mBlack, 0.04 * i, -0.34, 0.1);
        claw.rotation.x = Math.PI / 2.4;
        g.add(claw);
      }
      return this.joint(g);
    };

    this.body = this.joint(bodyN);
    this.head = this.joint(headN);
    this.tailFan = this.joint(tailN);
    this.tail = this.tailFan;
    [this.wingLIn, this.wingLOut] = mkWing(-1);
    [this.wingRIn, this.wingROut] = mkWing(1);
    this.legs = [mkLeg(-1), mkLeg(1)];
    this.finalize();
  }

  /** Spread the wings: 0 = folded rest, 1 = full span. `flap` adds beat angle. */
  private wings(spread: number, flap = 0): void {
    this.wingLIn.rz = (FOLD_IN - flap) * spread;
    this.wingLOut.rz = -FOLD_OUT * spread;
    this.wingRIn.rz = -(FOLD_IN - flap) * spread;
    this.wingROut.rz = FOLD_OUT * spread;
  }

  protected poseIdle(t: number): void {
    this.body.py = Math.sin(t) * 0.012;
    this.body.s = 1 + Math.sin(t) * 0.008;
    this.head.ry = Math.sin(t * 0.5) * 0.5; // sharp scanning turns
    this.head.rx = Math.max(0, Math.sin(t * 0.23)) * 0.3; // preen dip
    this.tailFan.ry = Math.sin(t * 0.7) * 0.1;
    this.wings(0, 0);
  }

  protected poseRun(speed: number): void {
    // Bounding hop-run with half-open fluttering wings.
    const k = Math.min(1, speed / this.def.speed);
    const g = this.gaitPhase;
    this.legs[0].rx = Math.sin(g) * 0.9 * k;
    this.legs[1].rx = Math.sin(g + Math.PI) * 0.9 * k;
    this.body.py = Math.abs(Math.sin(g)) * 0.08 * k;
    this.body.rx = 0.25 * k;
    this.head.rx = -0.25 * k;
    this.wings(0.45 * k, Math.sin(g * 2) * 0.35 * k);
    this.tailFan.rx = 0.2 * k;
  }

  protected poseAttack(n: 1 | 2 | 3, u: number): void {
    const s = attackCurve(u);
    if (n === 1 || n === 2) {
      // Talon rake: rear back, wings flared, foot lashes out at 55%.
      const leg = this.legs[n === 1 ? 1 : 0];
      leg.rx = -1.7 * s;
      this.body.rx = -0.35 * Math.max(0, s) - 0.1 * Math.min(0, s);
      this.body.py = 0.06 * Math.abs(s);
      this.wings(0.8 * Math.abs(s), Math.max(0, s) * 0.4);
      this.head.rx = 0.2 * s;
    } else {
      // Beak Pierce: coiled neck, spearing lunge at 55%.
      this.head.rx = 0.7 * s;
      this.head.pz = 0.14 * Math.max(0, s);
      this.body.rx = 0.35 * s;
      this.body.pz = 0.2 * Math.max(0, s);
      this.wings(0.5 * Math.abs(s), -0.2 * Math.max(0, s));
      this.tailFan.rx = -0.3 * s;
    }
  }

  protected poseSpecial(u: number, _state: FighterState): void {
    // Gale Burst: rear up and hammer both wings forward at the impact instant.
    const rear = smooth01(ramp(u, 0, 0.35));
    const sweep = impactPulse(u, 0.12);
    this.body.rx = -0.4 * rear * (1 - sweep) + 0.15 * sweep;
    this.body.py = 0.1 * rear;
    this.wings(rear, -1.1 * rear + 2.0 * sweep);
    this.wingLIn.ry = -0.8 * sweep;
    this.wingRIn.ry = 0.8 * sweep;
    this.head.rx = -0.2 * rear + 0.25 * sweep;
    this.legs[0].rx = 0.4 * rear;
    this.legs[1].rx = 0.4 * rear;
  }

  protected poseUltimate(u: number, state: FighterState): void {
    // Death From Above: powered soar, then fold into the stoop. The sim owns
    // altitude; the pose reads the phase from u and the fall from vel.y.
    if (u < IMPACT) {
      const k = smooth01(ramp(u, 0, 0.2));
      this.wings(k, Math.sin(this.timePhase * 18) * 0.65 * k);
      this.body.rx = -0.5 * k;
      this.head.rx = 0.45 * k; // eyes locked below
      this.legs[0].rx = 0.5 * k;
      this.legs[1].rx = 0.5 * k;
      this.tailFan.rx = 0.35 * k;
    } else {
      const dive = state.vel.y < -1 ? 1 : smooth01(ramp(u, IMPACT, 0.62));
      this.wings(0.25 * (1 - dive), 0);
      this.wingLIn.ry = 1.0 * dive;
      this.wingRIn.ry = -1.0 * dive;
      this.body.rx = 0.9 * dive;
      this.head.rx = 0.3 * dive;
      this.legs[0].rx = -1.2 * dive; // talons first
      this.legs[1].rx = -1.2 * dive;
    }
  }

  protected poseBlock(t: number): void {
    // Wing shield: mantled forward like guarding a kill.
    this.body.rx = 0.15;
    this.body.py = -0.06 + Math.sin(t * 2) * 0.008;
    this.wings(0.7, -0.9);
    this.wingLIn.ry = -0.7;
    this.wingRIn.ry = 0.7;
    this.head.rx = 0.3;
    this.head.py = -0.05;
  }

  protected override poseJump(state: FighterState): void {
    const up = state.vel.y > 0;
    this.wings(1, up ? Math.sin(this.timePhase * 20) * 0.7 : 0.15);
    this.body.rx = up ? -0.25 : 0.15;
    this.legs[0].rx = 0.5;
    this.legs[1].rx = 0.5;
  }

  protected override poseGlide(state: FighterState): void {
    // Full-span glide (§7.8: y handled by the sim). Gentle rocking soar.
    const rock = Math.sin(this.timePhase * 1.6) * 0.06;
    this.wings(1, Math.sin(this.timePhase * 2.2) * 0.08);
    this.body.rz = rock;
    this.body.rx = 0.12 + (state.vel.y < -0.5 ? 0.1 : 0);
    this.tailFan.rx = 0.25;
    this.legs[0].rx = 0.7;
    this.legs[1].rx = 0.7;
    this.head.rx = 0.15;
  }
}
