/**
 * MOLE — "The Undertaker" (§8 #10). Compact velvet teardrop with huge ivory
 * digging claws and a pink snout. Claw-swipe combo ending in Dirt Slinger,
 * Burrow special (mound handled by BaseRig; the special pose is the Uppercut
 * Eruption), and the Sinkhole ground-slam ultimate.
 *
 * v1.1: velvet coat with a soft sheen, a pink star nose (ring of fleshy rays
 * around nostrils), pin eyes with glints, broad pink digging palms with five
 * long ivory claws, clawed hind feet and a naked tail.
 */

import * as THREE from 'three';
import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, impactPulse, ramp, smooth01, IMPACT } from './Animator';
import {
  makeMat,
  part,
  pivot,
  sphGeo,
  coneGeo,
  cylGeo,
  openCyl,
  eye,
  noTone,
  noOutline,
  paint,
  mixColor,
  shade,
} from './parts';

export class MoleRig extends BaseRig {
  private readonly armL: Joint;
  private readonly armR: Joint;
  private readonly snout: Joint;

  constructor() {
    super(ANIMALS.mole);
    this.hipDrop = 0.22;
    this.strideRate = 0.8; // frantic little scurry steps
    this.stepScale = 0.35;
    this.toneBack = -0.18; // velvet sheen
    this.toneBelly = 0.15;
    this.outlineScale = 0.85;
    this.slams = [
      { action: 'special', at: IMPACT, radius: 1.6, kind: 'crack', forward: 0 },
      { action: 'ultimate', at: IMPACT, radius: 1.4, kind: 'crack', forward: 0.5 },
    ];
    const p = this.pal;
    const fur = mixColor(p.dark, 0x3a3230, 0.45);
    const mBody = makeMat(fur);
    const mBelly = makeMat(shade(fur, 0.18));
    const mClaw = makeMat(0xf0e6cc);
    const mPink = makeMat(0xe39a8a);
    const mPinkDeep = makeMat(0xc9706a);
    const mNostril = makeMat(0x5a2a26);

    const velvet = (pp: THREE.Vector3, _n: THREE.Vector3, c: THREE.Color): void => {
      if (Math.sin(pp.z * 26 + pp.y * 10) > 0.75) c.multiplyScalar(0.9);
    };

    const bodyN = pivot(0, 0.36, 0);
    this.bodyRoot.add(bodyN);
    bodyN.add(paint(part(sphGeo(0.3, 10, 8), mBody, 0, 0, -0.02, 1.0, 0.95, 1.3), velvet));
    bodyN.add(part(sphGeo(0.26, 8, 5), mBelly, 0, -0.1, 0.02, 0.9, 0.7, 1.2));

    // Head is mostly snout, tipped with the star nose.
    const headN = pivot(0, 0.1, 0.3);
    bodyN.add(headN);
    headN.add(paint(part(sphGeo(0.16, 9, 6), mBody, 0, 0, 0.02, 1, 0.95, 1.05), velvet));
    const snoutN = pivot(0, 0, 0.12);
    headN.add(snoutN);
    snoutN.add(part(coneGeo(0.1, 0.26, 8), mBody, 0, 0, 0.12, 1, 1, 0.9, Math.PI / 2));
    snoutN.add(part(cylGeo(0.05, 0.06, 0.04, 8), mPink, 0, 0, 0.255, 1, 1, 1, Math.PI / 2)); // nose disc
    const rays = 10;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      const ray = part(coneGeo(0.018, 0.075, 4), i % 2 ? mPink : mPinkDeep, Math.cos(a) * 0.06, Math.sin(a) * 0.06, 0.265, 1, 1, 1, 0.25, 0, a - Math.PI / 2);
      snoutN.add(noOutline(noTone(ray)));
    }
    snoutN.add(noOutline(noTone(part(sphGeo(0.012, 4, 2), mNostril, -0.018, 0.0, 0.278))));
    snoutN.add(noOutline(noTone(part(sphGeo(0.012, 4, 2), mNostril, 0.018, 0.0, 0.278))));
    for (const sx of [-1, 1]) {
      const e = eye({ r: 0.02, iris: 0x120d0c, side: sx, lateral: 0.5 });
      e.position.set(sx * 0.075, 0.07, 0.1);
      headN.add(e);
    }

    // Massive shovel claws on stubby arms.
    const mkArm = (side: number): Joint => {
      const sh = pivot(0.27 * side, -0.02, 0.18);
      sh.rotation.z = 0.3 * side;
      bodyN.add(sh);
      sh.add(part(sphGeo(0.09, 7, 5), mBody, 0, -0.02, 0));
      sh.add(part(openCyl(0.075, 0.06, 0.16, 6), mBody, 0, -0.08, 0));
      sh.add(noTone(part(sphGeo(0.11, 8, 5), mPink, 0, -0.22, 0.02, 0.85, 1.0, 0.45))); // palm
      for (let i = -2; i <= 2; i++) {
        const claw = part(coneGeo(0.026, 0.17 - Math.abs(i) * 0.02, 4), mClaw, 0.036 * i, -0.36 + Math.abs(i) * 0.01, 0.04, 1, 1, 0.7, Math.PI, 0, i * 0.08);
        sh.add(noOutline(noTone(claw)));
      }
      return this.joint(sh);
    };

    // Small hind feet.
    const mkLeg = (side: number): Joint => {
      const g = pivot(0.16 * side, -0.24, -0.16);
      bodyN.add(g);
      g.add(part(openCyl(0.05, 0.045, 0.14, 5), mBody, 0, -0.07, 0));
      g.add(noTone(part(sphGeo(0.055, 6, 4), mPink, 0, -0.14, 0.03, 1, 0.6, 1.4)));
      for (let i = -1; i <= 1; i++) {
        g.add(noOutline(noTone(part(coneGeo(0.012, 0.05, 4), mClaw, 0.025 * i, -0.15, 0.1, 1, 1, 1, Math.PI / 2))));
      }
      return this.joint(g);
    };

    // Thin naked tail.
    const tailN = pivot(0, 0.06, -0.38);
    tailN.rotation.x = 0.7;
    bodyN.add(tailN);
    tailN.add(noTone(part(cylGeo(0.022, 0.012, 0.22, 5), mPink, 0, -0.11, 0)));

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
