/**
 * EAGLE — "The Sky Terror" (§8 #6). Wings + tail-fan silhouette, white head,
 * hooked beak. Talon rakes and Beak Pierce combo, Gale Burst wing-sweep
 * special, Death From Above soar-and-dive ultimate, and the glide (§7.8).
 *
 * v1.1: layered wings (covert shell + overlapping secondaries + fanned
 * primaries), scalloped body plumage, white head with a fierce brow, yellow
 * cere and hooked beak, golden eyes, a fanned white tail, feathered "trousers"
 * over scaly yellow legs and black talons.
 */

import * as THREE from 'three';
import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, impactPulse, ramp, smooth01, IMPACT } from './Animator';
import {
  makeMat,
  part,
  pivot,
  boxGeo,
  sphGeo,
  coneGeo,
  openCyl,
  eye,
  noTone,
  noOutline,
  paint,
  mixColor,
  shade,
} from './parts';

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
    this.stepScale = 0.35;
    this.toneBack = 0.16;
    this.toneBelly = 0.18;
    this.slams = [{ action: 'ultimate', at: IMPACT, radius: 1.6, kind: 'crack', forward: 0 }];
    const p = this.pal;
    const brown = mixColor(p.darker, 0x3b2414, 0.5);
    const mBody = makeMat(brown);
    const mWing = makeMat(shade(brown, -0.15));
    const mWingLt = makeMat(mixColor(p.dark, 0x5a3a20, 0.4));
    const mPrimary = makeMat(shade(brown, -0.35));
    const mWhite = makeMat(0xf4f0e6);
    const mWhite2 = makeMat(0xe2dccd);
    const mBeak = makeMat(0xe7b52a);
    const mBeakTip = makeMat(0x9a7418);
    const mLeg = makeMat(0xe0b53a);
    const mTalon = makeMat(0x1c1a18);

    const scallops = (pp: THREE.Vector3, _n: THREE.Vector3, c: THREE.Color): void => {
      const v = Math.sin(pp.y * 34 + Math.sin(pp.x * 22) * 1.6) + Math.sin(pp.z * 30) * 0.35;
      if (v > 0.8) c.multiplyScalar(0.78);
      else if (v < -0.9) c.multiplyScalar(1.12);
    };

    const bodyN = pivot(0, 0.72, 0);
    this.bodyRoot.add(bodyN);
    bodyN.add(paint(part(sphGeo(0.3, 10, 7), mBody, 0, 0, 0, 0.85, 1.0, 1.35, 0.45), scallops));
    bodyN.add(paint(part(sphGeo(0.2, 8, 6), mWingLt, 0, -0.1, 0.22, 1, 1, 0.9), scallops)); // chest
    bodyN.add(part(sphGeo(0.17, 7, 5), mWhite, 0, 0.3, 0.14, 1.1, 0.9, 1)); // white neck ruff

    // White head with a fierce brow and hooked golden beak.
    const headN = pivot(0, 0.4, 0.2);
    bodyN.add(headN);
    headN.add(part(sphGeo(0.16, 9, 7), mWhite, 0, 0.02, 0, 1, 0.95, 1.08));
    headN.add(part(sphGeo(0.08, 6, 4), mWhite2, 0, 0.1, 0.1, 1.9, 0.45, 0.9)); // brow ridge
    headN.add(noTone(part(sphGeo(0.06, 6, 4), mBeak, 0, 0.03, 0.15, 1, 0.85, 1.1))); // cere
    headN.add(noTone(part(coneGeo(0.058, 0.2, 6), mBeak, 0, 0.02, 0.24, 1, 1, 0.85, Math.PI / 2)));
    headN.add(noTone(part(coneGeo(0.034, 0.09, 5), mBeakTip, 0, -0.035, 0.32, 1, 1, 1, Math.PI * 0.95)));
    headN.add(noTone(part(coneGeo(0.04, 0.12, 5), mBeak, 0, -0.04, 0.2, 1, 1, 0.7, Math.PI / 2 + 0.15))); // lower mandible
    for (const sx of [-1, 1]) {
      const e = eye({ r: 0.032, iris: 0xf2c230, side: sx, lateral: 0.55 });
      e.position.set(sx * 0.085, 0.06, 0.1);
      headN.add(e);
    }

    // Fanned white tail.
    const tailN = pivot(0, -0.12, -0.32);
    tailN.rotation.x = -0.25;
    bodyN.add(tailN);
    for (let i = 0; i < 7; i++) {
      const a = (i - 3) * 0.16;
      const fe = part(boxGeo(0.085, 0.022, 0.44), i % 2 === 0 ? mWhite : mWhite2, Math.sin(a) * 0.2, 0.003 * i, -0.22 - Math.cos(a) * 0.02, 1, 1, 1, 0, a);
      tailN.add(fe);
    }

    // Layered wings; rest pose folded.
    const mkWing = (side: number): [Joint, Joint] => {
      const inn = pivot(0.2 * side, 0.18, 0.02);
      inn.rotation.z = -FOLD_IN * side;
      bodyN.add(inn);
      inn.add(paint(part(sphGeo(0.3, 8, 5), mWingLt, 0.27 * side, 0.015, 0.0, 0.95, 0.13, 0.6), scallops)); // coverts
      for (let i = 0; i < 4; i++) {
        const x = (0.08 + i * 0.14) * side;
        inn.add(part(boxGeo(0.13, 0.024, 0.4), mWing, x, -0.008 - i * 0.003, -0.2, 1, 1, 1, 0, side * 0.08 * i));
      }
      const out = pivot(0.55 * side, 0, 0);
      out.rotation.z = FOLD_OUT * side;
      inn.add(out);
      out.add(part(sphGeo(0.24, 7, 4), mWing, 0.2 * side, 0.01, -0.02, 1, 0.12, 0.55)); // outer coverts
      for (let i = 0; i < 5; i++) {
        const x = (0.1 + i * 0.1) * side;
        const fan = side * (0.04 + i * 0.07);
        out.add(part(boxGeo(0.09, 0.02, 0.4), mPrimary, x, -0.006 * i, -0.14 - i * 0.015, 1, 1, 1, 0, fan));
      }
      return [this.joint(inn), this.joint(out)];
    };

    // Feathered trousers, scaly yellow legs, black talons.
    const mkLeg = (side: number): Joint => {
      const g = pivot(0.12 * side, -0.26, 0.06);
      bodyN.add(g);
      g.add(part(sphGeo(0.09, 7, 5), mBody, 0, -0.02, 0, 1, 1.3, 1));
      g.add(part(openCyl(0.035, 0.03, 0.3, 6), mLeg, 0, -0.17, 0));
      g.add(noTone(part(sphGeo(0.05, 6, 4), mLeg, 0, -0.32, 0.03, 1.1, 0.55, 1.2)));
      for (let i = -1; i <= 1; i++) {
        g.add(noOutline(noTone(part(coneGeo(0.018, 0.1, 4), mTalon, 0.042 * i, -0.34, 0.1, 1, 1, 1, Math.PI / 2.2, 0, -i * 0.2))));
      }
      g.add(noOutline(noTone(part(coneGeo(0.018, 0.08, 4), mTalon, 0, -0.33, -0.05, 1, 1, 1, -Math.PI / 2.2))));
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
