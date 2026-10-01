/**
 * RHINO — "The Battering Ram" (§8 #5). Horn + armor-plate silhouette. Horn
 * hooks and the launching Horn Fling finisher, Lockdown Charge special, and
 * the Seismic Stampede ultimate (v1.3: head-down paw wind-up, a thundering
 * homing gallop that leans into its turns, the gore-toss horn lift, a skidding
 * stop or a wall-crush jolt, then a shake-off; see `poseUltimate`).
 *
 * v1.1: shoulder and hip armour shells with knobbly hide and deep skin-fold
 * creases, a long tapering head with a big front horn + second horn, tubular
 * ears, small side eyes, nostrils, pillar legs on three-toed feet, tail tuft.
 */

import * as THREE from 'three';
import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, bell, easeInCubic, easeOutCubic, impactPulse, ramp, smooth01 } from './Animator';
import { angleDelta } from '../../core/math';
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
  /** Smoothed yaw rate (rad/s) of the sim heading: drives the lean into turns during the stampede. */
  private turnRate = 0;
  private prevYaw = 0;
  private haveYaw = false;

  constructor() {
    super(ANIMALS.rhino);
    this.hipDrop = 0.45;
    this.strideRate = 0.27;
    this.stepScale = 1.0;
    this.outlineScale = 1.2;
    // The ultimate's impact decals / dust are drawn by src/render/ultFx/rhino.ts (its phase clocks restart per beat).
    this.slams = [
      { action: 'special', at: 0.2, radius: 1.7, kind: 'ring', forward: 1.4 },
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

  update(state: FighterState, dtRender: number): void {
    // Yaw rate of the sim heading (first frame ignored), low-passed: the body leans into turns.
    if (this.haveYaw && dtRender > 1e-4) {
      const r = Math.max(-5, Math.min(5, angleDelta(this.prevYaw, state.yaw) / dtRender));
      this.turnRate += (r - this.turnRate) * Math.min(1, dtRender * 9);
    }
    this.prevYaw = state.yaw;
    this.haveYaw = true;
    super.update(state, dtRender);
  }

  /**
   * Seismic Stampede (v1.3). Driven ONLY by `ultPhase / ultStage / actionT / actionDur / vel / yaw` (the sim restarts
   * the phase clock at the paw / charge / gore / skid / recovery beats; the Animator cross-fades 0.1 s at each):
   *  - paw (windup, 0.8 s)    the head LOWERS (cubic ease-out) toward the sand, the forefeet paw alternately (lift,
   *                           scrape back), the body rocks with each scrape and the haunches bunch at the end;
   *  - gallop (stage 1)       builds from that crouch into a thundering gallop: legs, bob and head nod follow the real
   *                           ground speed and the body ROLLS INTO TURNS with the head leading them;
   *  - gore (stage 2)         a violent horn LIFT (cubic ease-out with an overshoot flick) that holds the head up while
   *                           the victim rides the horn, the gallop going on beneath;
   *  - skid (stage 4)         legs braced out front, weight thrown back, body low and head up as it slides;
   *  - crush (stage 3, recov) a jolt forward into the wall, the horn dips as the victim drops, then a hard head shake;
   *  - shake-off (recovery)   a decaying head and body shake, the stance settling back to idle.
   */
  protected poseUltimate(_u: number, state: FighterState): void {
    const t = state.actionT;
    const dur = state.actionDur;
    const ph = state.ultPhase;
    const stage = state.ultStage ?? 0;
    if (ph === 'recovery') this.stampedeShake(t, dur, stage);
    else if (ph === 'active') this.stampedeGallop(t, stage, Math.hypot(state.vel.x, state.vel.z));
    else this.stampedePaw(t);
  }

  /** Forefoot paw cycle: -1 = lifted forward, +0.5 = scraped back. */
  private static paw(x: number): number {
    const s = Math.sin(x);
    return s > 0 ? -easeOutCubic(s) : -0.5 * s;
  }

  private stampedePaw(t: number): void {
    const lower = easeOutCubic(ramp(t, 0, 0.35));
    const paw = smooth01(ramp(t, 0.1, 0.3));
    const coil = smooth01(ramp(t, 0.58, 0.8));
    const ph = t * 10.5;
    this.body.rx = 0.14 * lower + 0.14 * coil - 0.035 * Math.sin(ph) * paw;
    this.body.py = -0.08 * lower - 0.13 * coil;
    this.body.pz = -0.05 * coil;
    this.head.rx = 0.7 * lower + 0.1 * coil + Math.sin(ph * 0.5) * 0.05 * paw;
    this.head.ry = Math.sin(ph * 0.5 + 0.6) * 0.14 * paw;
    this.legs[0].rx = 0.85 * RhinoRig.paw(ph) * paw;
    this.legs[1].rx = 0.85 * RhinoRig.paw(ph + Math.PI) * paw;
    this.legs[2].rx = 0.32 * coil;
    this.legs[3].rx = 0.32 * coil;
    if (this.tail) {
      this.tail.ry = Math.sin(t * 12) * 0.5 * paw;
      this.tail.rx = -0.4 * coil;
    }
  }

  private stampedeGallop(t: number, stage: number, speed: number): void {
    const sk = Math.min(1, speed / 12);
    // Blend from the crouch of the windup into the gallop over the first strides of the charge.
    const k = stage === 1 ? smooth01(ramp(t, 0, 0.35)) : 1;
    const g = this.gaitPhase;
    const lean = Math.max(-0.26, Math.min(0.26, this.turnRate * 0.22));
    let bodyRx = 0.16 * k + 0.04 * Math.sin(g * 2) * sk;
    let bodyPy = -0.08 * k + Math.abs(Math.sin(g)) * 0.06 * sk;
    let headRx = 0.4 * k + 0.07 * Math.sin(g * 2 + 1) * sk;
    const legAmp = 0.85 * sk * k;
    const legs = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) legs[i] = Math.sin(g + (i % 2 === 0 ? 0 : Math.PI) + (i < 2 ? 0 : 0.9)) * legAmp;
    this.body.rz = -lean * k;
    this.body.ry = -this.turnRate * 0.03 * k;
    this.head.ry = this.turnRate * 0.11 * k;
    if (this.tail) {
      this.tail.rx = -0.4 * k;
      this.tail.ry = Math.sin(g * 1.5) * 0.25 * sk;
    }
    if (stage === 2) {
      // Gore-toss: the horn flicks up and holds while the victim rides it.
      const lift = easeOutCubic(ramp(t, 0, 0.3));
      const flick = bell(t, 0.12, 0.16);
      headRx = headRx * (1 - lift) + -0.5 * lift - 0.4 * flick;
      bodyRx = bodyRx * (1 - lift) + -0.06 * lift;
      bodyPy += 0.07 * lift;
      this.head.ry += Math.sin(t * 28) * 0.05 * (1 - lift * 0.5);
    } else if (stage === 4) {
      // Skid: legs braced out front, weight back, body low, head up.
      const brace = smooth01(ramp(t, 0, 0.2));
      bodyRx = bodyRx * (1 - brace) + -0.14 * brace;
      bodyPy = bodyPy * (1 - brace) + -0.14 * brace;
      headRx = headRx * (1 - brace) + 0.15 * brace;
      legs[0] = legs[0] * (1 - brace) - 0.6 * brace;
      legs[1] = legs[1] * (1 - brace) - 0.6 * brace;
      legs[2] = legs[2] * (1 - brace) + 0.4 * brace;
      legs[3] = legs[3] * (1 - brace) + 0.4 * brace;
      this.body.rz *= 1 - brace;
      this.head.ry *= 1 - brace;
    }
    this.body.rx = bodyRx;
    this.body.py = bodyPy;
    this.head.rx = headRx;
    for (let i = 0; i < 4; i++) this.legs[i].rx = legs[i];
  }

  private stampedeShake(t: number, dur: number, stage: number): void {
    const k = smooth01(ramp(t, 0.18, Math.max(0.4, dur)));
    const decay = 1 - k;
    const shake = Math.sin(t * 34) * decay * smooth01(ramp(t, 0.12, 0.26));
    if (stage === 3) {
      // Crush: a jolt forward into the wall, the horn dips as the victim drops off it, then the head shake.
      const jolt = easeInCubic(ramp(t, 0, 0.07)) * (1 - smooth01(ramp(t, 0.07, 0.34)));
      const drop = easeOutCubic(ramp(t, 0.05, 0.26));
      this.body.rx = 0.3 * jolt;
      this.body.py = -0.1 * jolt - 0.04 * decay;
      this.body.pz = 0.2 * jolt;
      this.head.rx = (-0.5 * (1 - drop) + 0.45 * drop) * decay;
      this.legs[0].rx = -0.3 * jolt;
      this.legs[1].rx = -0.3 * jolt;
      this.legs[2].rx = 0.25 * jolt;
      this.legs[3].rx = 0.25 * jolt;
    } else {
      // Stop after a skid / a glancing hit: the braced stance relaxes.
      this.body.rx = -0.14 * decay;
      this.body.py = -0.14 * decay;
      this.head.rx = 0.15 * decay;
      this.legs[0].rx = -0.6 * decay;
      this.legs[1].rx = -0.6 * decay;
      this.legs[2].rx = 0.4 * decay;
      this.legs[3].rx = 0.4 * decay;
    }
    this.head.ry = shake * 0.3;
    this.head.rz = shake * 0.12;
    this.body.ry = -shake * 0.05;
    this.body.rz = shake * 0.03;
    if (this.tail) this.tail.ry = Math.sin(t * 7) * 0.3 * decay;
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
