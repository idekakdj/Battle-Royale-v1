/**
 * GORILLA — "The Silverback" (§8 #2). Knuckle-walking hulk: huge shoulders and
 * arms, silver back panel. Hooks + Double-Fist Slam combo, Silverback Leap
 * slam special, chest-beating Primal Rampage ultimate.
 *
 * v1.1: barrel torso with leathery chest, a real silver saddle across the
 * back, deltoid/bicep mass, knuckled fists, a sagittal-crest skull with a dark
 * face mask, heavy brow, eyes, nostrils and ears.
 */

import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, impactPulse, ramp, smooth01, IMPACT } from './Animator';
import { makeMat, part, pivot, sphGeo, openCyl, capGeo, eye, noTone, noOutline, paint, mixColor, shade, col } from './parts';

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
    this.stepScale = 0.85;
    this.outlineScale = 1.1;
    this.toneBack = 0.12;
    this.toneBelly = 0.2;
    this.slams = [
      { action: 'attack3', at: IMPACT, radius: 1.8, kind: 'crack', forward: 1.0 },
      { action: 'special', at: IMPACT, radius: 2.5, kind: 'crack', forward: 0.6 },
    ];
    const p = this.pal;
    const furCol = mixColor(p.darker, 0x1b1a1d, 0.45);
    const mFur = makeMat(furCol);
    const mFur2 = makeMat(shade(furCol, 0.12));
    const silverCol = mixColor(p.light, 0xd2d4d8, 0.55);
    const mSilver = makeMat(silverCol);
    const mSkin = makeMat(0x35302f);
    const mSkinDark = makeMat(0x221e1d);
    const mNail = makeMat(0x4a4038);

    const bodyN = pivot(0, 0.78, 0);
    this.bodyRoot.add(bodyN);
    bodyN.add(part(sphGeo(0.46, 10, 7), mFur, 0, 0.2, 0.02, 1.02, 0.98, 0.78, 0.22)); // barrel
    // Silver saddle across the back (streaky toward the edges).
    const saddle = part(sphGeo(0.37, 9, 6), mSilver, 0, 0.26, -0.2, 1.06, 0.72, 0.62, 0.22);
    const furC = col(furCol);
    paint(saddle, (pp, _n, c) => {
      const edge = Math.min(1, Math.abs(pp.x) / 0.36);
      const streak = Math.sin(pp.y * 38 + pp.x * 9) > 0.55 ? 0.82 : 1;
      c.lerp(furC, edge * edge * 0.55).multiplyScalar(streak);
    });
    bodyN.add(saddle);
    bodyN.add(part(sphGeo(0.32, 9, 6), mFur, 0, -0.28, -0.02, 1.05, 0.85, 0.9)); // pelvis
    bodyN.add(part(sphGeo(0.28, 8, 5), mFur2, 0, -0.06, 0.2, 1.05, 0.8, 0.6)); // belly
    // Leathery chest plates.
    bodyN.add(noTone(part(sphGeo(0.15, 7, 5), mSkin, -0.14, 0.32, 0.3, 1.15, 0.8, 0.5, 0.2)));
    bodyN.add(noTone(part(sphGeo(0.15, 7, 5), mSkin, 0.14, 0.32, 0.3, 1.15, 0.8, 0.5, 0.2)));

    // Head: crest skull, dark face mask, heavy brow, muzzle.
    const headN = pivot(0, 0.62, 0.3);
    bodyN.add(headN);
    headN.add(part(sphGeo(0.19, 9, 6), mFur, 0, 0.05, 0.03, 1.05, 1, 1));
    headN.add(part(sphGeo(0.13, 7, 5), mFur, 0, 0.2, -0.04, 0.62, 1, 1.25)); // sagittal crest
    headN.add(noTone(part(sphGeo(0.15, 8, 5), mSkin, 0, 0.0, 0.14, 1.12, 1.05, 0.7))); // face mask
    headN.add(part(capGeo(0.05, 0.22, 6), mSkinDark, 0, 0.1, 0.21, 1, 1, 1.1, 0, 0, Math.PI / 2)); // brow
    headN.add(noTone(part(sphGeo(0.11, 8, 5), mSkin, 0, -0.08, 0.22, 1.28, 0.85, 0.82))); // muzzle
    headN.add(noOutline(noTone(part(sphGeo(0.028, 5, 3), mSkinDark, -0.035, -0.035, 0.31, 1, 0.8, 0.7))));
    headN.add(noOutline(noTone(part(sphGeo(0.028, 5, 3), mSkinDark, 0.035, -0.035, 0.31, 1, 0.8, 0.7))));
    headN.add(noOutline(noTone(part(sphGeo(0.06, 6, 3), mSkinDark, 0, -0.13, 0.28, 1.4, 0.25, 0.5)))); // mouth
    for (const sx of [-1, 1]) {
      const e = eye({ r: 0.028, iris: 0x5a3818, side: sx, lateral: 0.15 });
      e.position.set(sx * 0.068, 0.05, 0.235);
      headN.add(e);
      headN.add(noTone(part(sphGeo(0.045, 6, 4), mSkin, sx * 0.19, 0.03, 0.0, 0.5, 1, 0.9))); // ears
    }

    // Arms: shoulder + forearm joints, ending in knuckled fists.
    const mkArm = (side: number): [Joint, Joint] => {
      const sh = pivot(0.52 * side, 0.42, 0.12);
      sh.rotation.x = 0.35;
      bodyN.add(sh);
      sh.add(part(sphGeo(0.21, 8, 6), mFur, 0, -0.02, 0, 1, 1.05, 1)); // deltoid
      sh.add(part(openCyl(0.16, 0.13, 0.5, 8), mFur, 0, -0.25, 0));
      sh.add(part(sphGeo(0.14, 7, 5), mFur2, 0, -0.22, 0.05, 0.95, 1.5, 0.9)); // bicep
      const el = pivot(0, -0.5, 0);
      el.rotation.x = -0.15;
      sh.add(el);
      el.add(part(sphGeo(0.13, 6, 4), mFur, 0, 0, 0));
      el.add(part(openCyl(0.14, 0.11, 0.55, 8), mFur, 0, -0.28, 0));
      el.add(part(sphGeo(0.13, 7, 5), mFur2, 0, -0.18, 0.02, 1, 1.7, 1)); // forearm mass
      el.add(noTone(part(sphGeo(0.16, 8, 5), mSkin, 0, -0.6, 0.02, 1, 0.9, 1.05))); // fist
      for (let k = 0; k < 4; k++) {
        const kx = (k - 1.5) * 0.065;
        el.add(noOutline(noTone(part(sphGeo(0.042, 5, 3), mNail, kx, -0.72, 0.1, 1, 0.8, 1))));
      }
      return [this.joint(sh), this.joint(el)];
    };

    // Short, thick legs with padded feet.
    const mkLeg = (side: number): Joint => {
      const hip = pivot(0.26 * side, -0.42, 0);
      bodyN.add(hip);
      hip.add(part(sphGeo(0.17, 7, 5), mFur, 0, -0.04, 0, 1, 1.2, 1));
      hip.add(part(openCyl(0.14, 0.11, 0.38, 7), mFur, 0, -0.19, 0));
      hip.add(noTone(part(sphGeo(0.13, 7, 4), mSkin, 0, -0.37, 0.07, 1, 0.55, 1.45)));
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
