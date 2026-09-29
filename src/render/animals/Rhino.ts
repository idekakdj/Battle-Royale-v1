/**
 * RHINO — "The Battering Ram" (§8 #5). Horn + armor-plate silhouette. Horn
 * hooks and the launching Horn Fling finisher, Lockdown Charge special, and
 * the steerable Seismic Stampede ultimate.
 *
 * v1.1: shoulder and hip armour shells with knobbly hide and deep skin-fold
 * creases, a long tapering head with a big front horn + second horn, tubular
 * ears, small side eyes, nostrils, pillar legs on three-toed feet, tail tuft.
 */

import * as THREE from 'three';
import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, impactPulse, ramp, smooth01 } from './Animator';
import {
  makeMat,
  part,
  pivot,
  sphGeo,
  coneGeo,
  cylGeo,
  openCyl,
  solidLeg,
  eye,
  noTone,
  noOutline,
  paint,
  cellular,
  mixColor,
  shade,
} from './parts';

export class RhinoRig extends BaseRig {
  constructor() {
    super(ANIMALS.rhino);
    this.hipDrop = 0.45;
    this.strideRate = 0.27;
    this.stepScale = 1.0;
    this.outlineScale = 1.2;
    this.slams = [
      { action: 'special', at: 0.2, radius: 1.7, kind: 'ring', forward: 1.4 },
      { action: 'ultimate', at: 0.12, radius: 2.8, kind: 'crack', forward: 0.8 },
      { action: 'attack3', at: 0.55, radius: 1.3, kind: 'ring', forward: 1.4 },
    ];
    const p = this.pal;
    const hideCol = mixColor(p.accent, 0x847c72, 0.3);
    const mBody = makeMat(hideCol);
    const mPlate = makeMat(shade(hideCol, 0.12));
    const mDark = makeMat(shade(hideCol, -0.3));
    const mHorn = makeMat(0xcfc2a3);
    const mHornTip = makeMat(0xe9dfc6);
    const mNostril = makeMat(0x252322);
    const mNail = makeMat(0x3d3834);

    const cell: [number, number] = [0, 0];
    const knobbly = (pp: THREE.Vector3, _n: THREE.Vector3, c: THREE.Color): void => {
      cellular(pp.x, pp.y, pp.z, 0.11, cell);
      if (cell[1] - cell[0] < 0.018) c.multiplyScalar(0.82);
    };
    const folds = (pp: THREE.Vector3, _n: THREE.Vector3, c: THREE.Color): void => {
      const z = pp.z;
      if (Math.abs(z - 0.16) < 0.05 || Math.abs(z + 0.36) < 0.05) c.multiplyScalar(0.7);
      else knobbly(pp, _n, c);
    };

    const bodyN = pivot(0, 1.02, 0);
    this.bodyRoot.add(bodyN);
    bodyN.add(paint(part(sphGeo(0.56, 11, 8), mBody, 0, 0, -0.05, 0.86, 0.76, 1.72), folds));
    // Armor shells: shoulder + hip, proud of the hide.
    bodyN.add(paint(part(sphGeo(0.52, 10, 7), mPlate, 0, 0.13, 0.45, 1.0, 0.74, 0.56), knobbly));
    bodyN.add(paint(part(sphGeo(0.5, 10, 7), mPlate, 0, 0.11, -0.62, 0.98, 0.74, 0.56), knobbly));
    bodyN.add(part(sphGeo(0.48, 8, 5), mDark, 0, -0.3, -0.05, 0.8, 0.45, 1.5)); // underbelly
    bodyN.add(part(sphGeo(0.3, 7, 5), mBody, 0, 0.2, 0.72, 1.3, 0.9, 0.7)); // neck hump

    // Head angled down, bearing the horns.
    const headN = pivot(0, 0.12, 0.95);
    headN.rotation.x = 0.3;
    bodyN.add(headN);
    headN.add(paint(part(sphGeo(0.28, 10, 7), mBody, 0, -0.03, 0.2, 0.86, 0.85, 1.3), knobbly));
    headN.add(part(sphGeo(0.2, 8, 6), mBody, 0, -0.1, 0.52, 1.0, 0.8, 1.0)); // snout
    headN.add(part(sphGeo(0.14, 7, 5), mPlate, 0, 0.05, 0.5, 1.1, 0.6, 1.0)); // horn boss
    const horn1 = part(coneGeo(0.13, 0.5, 7), mHorn, 0, 0.16, 0.56, 1, 1, 0.9, -0.45);
    headN.add(noTone(horn1));
    headN.add(noTone(part(coneGeo(0.075, 0.3, 6), mHornTip, 0, 0.42, 0.68, 1, 1, 1, -0.75)));
    headN.add(noTone(part(coneGeo(0.08, 0.3, 6), mHorn, 0, 0.27, 0.3, 1, 1, 0.9, -0.4)));
    for (const sx of [-1, 1]) {
      // Tubular ears with dark openings.
      const ear = part(openCyl(0.075, 0.04, 0.2, 7), mBody, sx * 0.2, 0.33, -0.1, 1, 1, 0.75, 0.2, 0, -sx * 0.35);
      headN.add(ear);
      headN.add(noOutline(part(sphGeo(0.05, 5, 3), mDark, sx * 0.23, 0.41, -0.08, 1, 0.4, 0.8, 0.2, 0, -sx * 0.35)));
      const e = eye({ r: 0.032, iris: 0x3a2618, side: sx, lateral: 0.85 });
      e.position.set(sx * 0.22, 0.08, 0.36);
      headN.add(e);
      headN.add(noOutline(noTone(part(sphGeo(0.03, 5, 3), mNostril, sx * 0.08, -0.12, 0.7, 1, 1.4, 0.6))));
    }
    headN.add(part(sphGeo(0.12, 7, 4), mDark, 0, -0.24, 0.5, 1.2, 0.5, 1.1)); // lip

    const mkLeg = (x: number, z: number, back: boolean): Joint => {
      const g = solidLeg({
        mat: mBody,
        footMat: mDark,
        clawMat: mNail,
        len: 0.67,
        rTop: back ? 0.27 : 0.25,
        rBot: 0.15,
        foot: 'pad',
        toes: 3,
        bend: 0,
      });
      g.position.set(x, -0.35, z);
      bodyN.add(g);
      return this.joint(g);
    };

    const tailN = pivot(0, 0.3, -0.95);
    tailN.rotation.x = 1.0;
    bodyN.add(tailN);
    tailN.add(part(cylGeo(0.04, 0.03, 0.45, 5), mDark, 0, -0.22, 0));
    tailN.add(part(coneGeo(0.06, 0.14, 5), mNostril, 0, -0.5, 0, 1, 1, 1, Math.PI));

    this.body = this.joint(bodyN);
    this.head = this.joint(headN);
    this.legs = [mkLeg(-0.4, 0.62, false), mkLeg(0.4, 0.62, false), mkLeg(-0.4, -0.62, true), mkLeg(0.4, -0.62, true)];
    this.tail = this.joint(tailN);
    this.finalize();
  }

  protected poseIdle(t: number): void {
    this.body.py = Math.sin(t) * 0.014;
    this.body.s = 1 + Math.sin(t) * 0.007;
    this.head.ry = Math.sin(t * 0.28) * 0.14;
    this.head.rx = Math.max(0, Math.sin(t * 0.15)) * 0.12; // pawing snuffle
    if (this.tail) this.tail.ry = Math.sin(t * 1.8) * 0.35;
  }

  protected poseRun(speed: number): void {
    this.quadGait(speed, 0.6, 0.07);
    const k = Math.min(1, speed / this.def.speed);
    this.head.rx = 0.1 * k; // head lowers as it builds steam
    this.body.rz = Math.sin(this.gaitPhase) * 0.03 * k;
    if (this.tail) this.tail.ry = Math.sin(this.gaitPhase * 2) * 0.25 * k;
  }

  protected poseAttack(n: 1 | 2 | 3, u: number): void {
    const s = attackCurve(u);
    if (n === 1 || n === 2) {
      // Horn hooks: dip then flick up and across.
      const side = n === 1 ? 1 : -1;
      this.head.rx = 0.5 * Math.min(0, s) - 0.7 * Math.max(0, s);
      this.head.rz = -0.45 * s * side;
      this.head.ry = -0.3 * s * side;
      this.body.rx = 0.1 * Math.min(0, s) - 0.12 * Math.max(0, s);
      this.body.ry = 0.2 * s * side;
    } else {
      // Horn Fling: deep dig, violent upward toss peaking at 55%.
      const dig = smooth01(ramp(u, 0, 0.35));
      const toss = impactPulse(u, 0.12);
      this.head.rx = 0.8 * dig * (1 - toss) - 1.0 * toss;
      this.body.rx = 0.22 * dig * (1 - toss) - 0.3 * toss;
      this.body.py = -0.12 * dig * (1 - toss) + 0.1 * toss;
      this.legs[0].rx = -0.5 * toss;
      this.legs[1].rx = -0.5 * toss;
    }
  }

  protected poseSpecial(u: number, _state: FighterState): void {
    // Lockdown Charge: horn levelled, body low, driving gallop.
    const k = smooth01(ramp(u, 0, 0.18)) * (1 - smooth01(ramp(u, 0.88, 1)));
    this.chargePose(k, this.timePhase * 15);
  }

  protected poseUltimate(u: number, _state: FighterState): void {
    // Seismic Stampede: sustained, heavier charge with a swaying head that
    // sells the steerable rampage; CC-immune juggernaut lean.
    const k = smooth01(ramp(u, 0, 0.12));
    this.chargePose(k, this.timePhase * 16);
    this.head.ry = Math.sin(this.timePhase * 5) * 0.18 * k;
    this.body.rz = Math.sin(this.timePhase * 8) * 0.045 * k;
  }

  private chargePose(k: number, g: number): void {
    this.body.rx = 0.16 * k;
    this.body.py = -0.08 * k;
    this.head.rx = 0.35 * k; // horn presented
    for (let i = 0; i < 4; i++) {
      this.legs[i].rx = Math.sin(g + (i % 2 === 0 ? 0 : Math.PI) + (i < 2 ? 0 : 0.9)) * 0.7 * k;
    }
    this.body.py += Math.abs(Math.sin(g)) * 0.05 * k;
    if (this.tail) this.tail.rx = -0.4 * k;
  }

  protected poseBlock(t: number): void {
    // Plant and present the horn — attackers eat thorns (§8 block perk).
    this.body.py = -0.1;
    this.body.rx = 0.12 + Math.sin(t * 2) * 0.01;
    this.head.rx = 0.55;
    this.legs[0].rx = -0.3;
    this.legs[1].rx = -0.3;
    this.legs[2].rx = 0.3;
    this.legs[3].rx = 0.3;
  }
}
