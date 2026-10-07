/**
 * HIPPO — "The Riverlord" (§8 #4). Huge barrel body and a colossal tusked maw.
 * Head-swing combo with a chomping finisher, River Rush charge special, and
 * the Riverlord's Flood ultimate (v1.3: rears up and bellows, slams both
 * forefeet, heaves a wave forward, then a heavy exhale; see `poseUltimate`).
 *
 * v1.1: shoulder hump + barrel with pink undertones and skin blotches, broad
 * muzzle with nostril bumps, eye turrets and little round ears on top, a pink
 * mouth with big curved tusks and incisors, stout four-toed legs.
 */

import * as THREE from 'three';
import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, ramp, smooth01, easeInCubic, easeOutCubic, IMPACT } from './Animator';
import { SWIM_BOB_W } from './swim';
import {
  makeMat,
  part,
  pivot,
  sphGeo,
  coneGeo,
  cylGeo,
  solidLeg,
  eye,
  noTone,
  noOutline,
  paint,
  cellular,
  col,
  mixColor,
  shade,
} from './parts';

export class HippoRig extends BaseRig {
  private readonly jaw: Joint;

  constructor() {
    super(ANIMALS.hippo);
    this.hipDrop = 0.38;
    this.strideRate = 0.26;
    this.stepScale = 1.05;
    this.outlineScale = 1.25;
    // The ultimate's slam decals / splashes are drawn by src/render/ultFx/hippo.ts (the ultimate's phase clocks
    // restart per phase, so a per-action `u` slam would fire at the wrong moments).
    this.slams = [{ action: 'special', at: 0.3, radius: 1.9, kind: 'ring', forward: 1.3 }];
    const p = this.pal;
    const skin = mixColor(p.accent, 0x7d6a78, 0.3);
    const pink = mixColor(p.belly, 0xe7a79c, 0.55);
    const mBody = makeMat(skin);
    const mDark = makeMat(shade(skin, -0.25));
    const mPink = makeMat(pink);
    const mMouth = makeMat(0xc9657a);
    const mTusk = makeMat(0xf2e8cf);
    const mNostril = makeMat(0x2a1d22);
    const mNail = makeMat(0x4a3a3e);

    const pinkC = col(pink);
    const cell: [number, number] = [0, 0];
    const hide = (pp: THREE.Vector3, n: THREE.Vector3, c: THREE.Color): void => {
      // Pink flush on the lower flanks + faint mottling.
      const low = n.y < -0.1 ? Math.min(1, (-n.y - 0.1) * 1.6) : 0;
      c.lerp(pinkC, low * 0.7);
      cellular(pp.x * 1.3, pp.y, pp.z, 0.28, cell);
      if (cell[0] < 0.07) c.multiplyScalar(0.9);
    };

    const bodyN = pivot(0, 0.98, 0);
    this.bodyRoot.add(bodyN);
    bodyN.add(paint(part(sphGeo(0.62, 11, 8), mBody, 0, 0, -0.1, 1.05, 0.95, 1.7), hide));
    bodyN.add(paint(part(sphGeo(0.5, 9, 6), mBody, 0, 0.12, 0.45, 1.05, 0.95, 0.9), hide)); // shoulder hump
    bodyN.add(part(sphGeo(0.55, 9, 6), mPink, 0, -0.26, -0.1, 0.92, 0.7, 1.5)); // belly

    // Massive head + hinged maw.
    const headN = pivot(0, 0.02, 0.95);
    bodyN.add(headN);
    headN.add(paint(part(sphGeo(0.34, 10, 7), mBody, 0, 0.12, 0.06, 1.08, 0.85, 1.0), hide)); // cranium
    headN.add(paint(part(sphGeo(0.32, 10, 7), mBody, 0, 0.0, 0.5, 1.08, 0.62, 0.92), hide)); // broad muzzle
    headN.add(part(sphGeo(0.26, 8, 5), mPink, 0, -0.1, 0.56, 1.15, 0.45, 0.85)); // upper lip
    for (const sx of [-1, 1]) {
      headN.add(part(sphGeo(0.08, 7, 5), mBody, sx * 0.12, 0.17, 0.74, 1, 0.75, 1)); // nostril bump
      headN.add(noOutline(noTone(part(sphGeo(0.03, 5, 3), mNostril, sx * 0.12, 0.22, 0.77, 1.3, 0.5, 0.8))));
      headN.add(part(sphGeo(0.085, 7, 5), mBody, sx * 0.23, 0.33, 0.24, 1, 0.8, 1)); // eye turret
      const e = eye({ r: 0.04, iris: 0x4a2a1c, side: sx, lateral: 0.55 });
      e.position.set(sx * 0.24, 0.36, 0.29);
      headN.add(e);
      headN.add(part(sphGeo(0.07, 6, 4), mDark, sx * 0.25, 0.4, -0.1, 1, 1.1, 0.5)); // round ears
      headN.add(noOutline(part(sphGeo(0.04, 5, 3), mPink, sx * 0.25, 0.4, -0.075, 1, 1, 0.3)));
    }
    const jawN = pivot(0, -0.2, 0.12);
    headN.add(jawN);
    jawN.add(part(sphGeo(0.33, 9, 6), mDark, 0, -0.1, 0.38, 1.02, 0.55, 1.1)); // lower jaw
    jawN.add(noOutline(part(sphGeo(0.27, 8, 4), mMouth, 0, 0.02, 0.42, 1.0, 0.18, 0.95))); // mouth
    // Big curved tusks + incisors from the lower jaw.
    for (const sx of [-1, 1]) {
      const tusk = part(coneGeo(0.06, 0.32, 6), mTusk, sx * 0.25, 0.12, 0.66, 1, 1, 0.8, 0.3, 0, -sx * 0.18);
      jawN.add(noTone(tusk));
      jawN.add(noTone(part(coneGeo(0.035, 0.15, 5), mTusk, sx * 0.1, 0.07, 0.74, 1, 1, 1, 0.35)));
    }

    // Stout four-toed legs.
    const mkLeg = (x: number, z: number, back: boolean): Joint => {
      const g = solidLeg({
        mat: mBody,
        footMat: mDark,
        clawMat: mNail,
        len: 0.62,
        rTop: back ? 0.26 : 0.23,
        rBot: 0.15,
        foot: 'pad',
        toes: 4,
        bend: 0,
      });
      g.position.set(x, -0.36, z);
      bodyN.add(g);
      return this.joint(g);
    };

    // Little paddle tail.
    const tailN = pivot(0, 0.22, -1.05);
    tailN.rotation.x = 0.9;
    bodyN.add(tailN);
    tailN.add(part(cylGeo(0.045, 0.03, 0.26, 5), mDark, 0, -0.13, 0));
    tailN.add(part(sphGeo(0.05, 5, 3), mDark, 0, -0.28, 0, 1.3, 1, 0.4));

    this.body = this.joint(bodyN);
    this.head = this.joint(headN);
    this.jaw = this.joint(jawN);
    this.legs = [mkLeg(-0.42, 0.62, false), mkLeg(0.42, 0.62, false), mkLeg(-0.42, -0.68, true), mkLeg(0.42, -0.68, true)];
    this.tail = this.joint(tailN);
    this.finalize();
  }

  protected poseIdle(t: number): void {
    this.body.py = Math.sin(t) * 0.016;
    this.body.s = 1 + Math.sin(t) * 0.009;
    this.head.ry = Math.sin(t * 0.3) * 0.12;
    this.jaw.rx = 0.06 + Math.max(0, Math.sin(t * 0.17)) * 0.5; // lazy territorial yawn
    if (this.tail) this.tail.ry = Math.sin(t * 2.2) * 0.4; // tail swish
  }

  protected poseRun(speed: number): void {
    this.quadGait(speed, 0.55, 0.06);
    const k = Math.min(1, speed / this.def.speed);
    this.head.rx = -0.08 * k;
    this.body.rz = Math.sin(this.gaitPhase) * 0.04 * k; // ponderous roll
    if (this.tail) this.tail.ry = Math.sin(this.gaitPhase * 2) * 0.3 * k;
  }

  protected poseAttack(n: 1 | 2 | 3, u: number): void {
    const s = attackCurve(u);
    if (n === 1 || n === 2) {
      // Sweeping head swings with the maw half open.
      const side = n === 1 ? 1 : -1;
      this.head.ry = -0.9 * s * side;
      this.head.rx = -0.1 * Math.abs(s);
      this.jaw.rx = 0.45 * Math.abs(s);
      this.body.ry = 0.3 * s * side;
      this.body.rx = -0.05 * s;
      this.legs[0].rx = -0.2 * s * side;
      this.legs[1].rx = 0.2 * s * side;
    } else {
      // Chomp finisher: gape then slam shut at the impact instant.
      const open = ramp(u, 0.05, 0.36);
      const close = ramp(u, 0.44, IMPACT);
      this.jaw.rx = 1.0 * open * (1 - close);
      this.head.rx = -0.4 * open * (1 - close) + 0.25 * Math.max(0, s);
      this.body.pz = 0.25 * Math.max(0, s);
      this.body.rx = 0.08 * Math.max(0, s);
    }
  }

  protected poseSpecial(u: number, _state: FighterState): void {
    // River Rush: bulldozing charge — head low, maw open, galloping.
    const k = smooth01(ramp(u, 0, 0.2)) * (1 - smooth01(ramp(u, 0.85, 1)));
    this.body.rx = 0.14 * k;
    this.head.rx = -0.15 * k;
    this.jaw.rx = 0.7 * k;
    const g = this.timePhase * 14;
    for (let i = 0; i < 4; i++) {
      this.legs[i].rx = Math.sin(g + (i % 2 === 0 ? 0 : Math.PI) + (i < 2 ? 0 : 0.8)) * 0.6 * k;
    }
    this.body.py = Math.abs(Math.sin(g)) * 0.05 * k;
  }

  /**
   * Riverlord's Flood (v1.3). Driven ONLY by `ultPhase / actionT / actionDur` (the sim restarts the phase clock at
   * each phase: windup = 0.9 s gape, active = the slam + surge (~0.8 s), recovery = 0.7 s exhale; the Animator
   * cross-fades 0.1 s at each restart):
   *  - rear-up      (0-0.4 s)   the forequarters rise on the planted hind legs, forefeet tucked and spread;
   *  - gape+bellow  (0.2-0.75)  the jaw cranks open (cubic ease-out) while the head tips back and the throat / chest
   *                             SWELL with a pulsing bellow and a fine roar shudder;
   *  - coil         (0.68-0.9)  a last lean back and the front legs cocked: anticipation for the slam;
   *  - slam         (0-0.13 s)  both forefeet hammer down (cubic ease-in), the whole body pitches forward;
   *  - surge        (0.05-0.8)  the body HEAVES forward along the wave (push then settle), a bouncing roll, the maw
   *                             still gaping as the flood pours out;
   *  - exhale       (0.7 s)     deflating heave: the chest swell collapses in decaying breaths, the jaw sags shut,
   *                             the head droops and the body settles back to its stance.
   */
  protected poseUltimate(_u: number, state: FighterState): void {
    const t = state.actionT;
    const dur = state.actionDur;
    const ph = state.ultPhase;
    if (ph === 'recovery') this.floodExhale(t, dur);
    else if (ph === 'active') this.floodSurge(t, dur);
    else this.floodGape(t);
  }

  private floodGape(t: number): void {
    const rear = smooth01(ramp(t, 0, 0.42));
    const gape = easeOutCubic(ramp(t, 0.18, 0.72));
    const swell = smooth01(ramp(t, 0.3, 0.8));
    const coil = smooth01(ramp(t, 0.68, 0.9));
    const pulse = 1 + 0.25 * Math.sin(t * 24);
    const roar = Math.sin(t * 38) * 0.035 * gape * swell;
    this.body.rx = -0.55 * rear - 0.2 * coil;
    this.body.py = 0.24 * rear + 0.04 * coil;
    this.body.pz = -0.12 * rear - 0.1 * coil;
    this.body.s = 1 + 0.06 * swell * pulse;
    this.body.rz = roar * 0.6;
    this.head.rx = -0.25 * gape;
    this.head.ry = roar;
    this.head.s = 1 + 0.12 * swell * pulse;
    this.jaw.rx = 1.55 * gape;
    // Hind legs stay planted under the hips as the body pitches back; the forefeet tuck up and spread wide.
    this.legs[2].rx = 0.55 * rear + 0.2 * coil;
    this.legs[3].rx = 0.55 * rear + 0.2 * coil;
    this.legs[0].rx = -1.0 * rear - 0.25 * coil;
    this.legs[1].rx = -1.0 * rear - 0.25 * coil;
    this.legs[0].rz = -0.15 * rear;
    this.legs[1].rz = 0.15 * rear;
    if (this.tail) this.tail.ry = Math.sin(t * 14) * 0.5 * swell;
  }

  private floodSurge(t: number, dur: number): void {
    const slam = easeInCubic(ramp(t, 0, 0.13));
    const push = easeOutCubic(ramp(t, 0.05, 0.34));
    const settle = smooth01(ramp(t, Math.max(0.3, dur - 0.24), dur));
    const gape = 1 - 0.4 * slam - 0.2 * smooth01(ramp(t, 0.3, dur));
    const heave = Math.sin(t * 15) * (1 - settle);
    // A = the coil the windup ended in, B = forefeet down and the body driven forward; `settle` blends into the
    // exhale pose so the next phase starts where this one ends.
    const brx = -0.75 + 1.05 * slam;
    const bpy = 0.28 - 0.42 * slam;
    const bpz = -0.22 + 0.52 * slam + 0.28 * push;
    this.body.rx = brx * (1 - settle) + 0.25 * settle + heave * 0.03;
    this.body.py = bpy * (1 - settle) - 0.1 * settle + Math.abs(heave) * 0.04 * slam;
    this.body.pz = bpz * (1 - settle);
    this.body.rz = heave * 0.05;
    this.body.ry = 0;
    this.body.s = 1 + 0.06 * (1 - slam) * (1 - settle) + 0.03 * (1 - settle) * slam;
    this.head.rx = (-0.25 + 0.6 * slam) * (1 - settle) + 0.3 * settle + heave * 0.05;
    this.head.ry = heave * 0.06;
    this.head.s = 1 + 0.12 * (1 - slam) * (1 - settle);
    this.jaw.rx = 1.55 * gape * (1 - settle) + 0.6 * settle;
    this.legs[0].rx = (-1.25 + 1.4 * slam) * (1 - settle) + 0.15 * settle;
    this.legs[1].rx = (-1.25 + 1.4 * slam) * (1 - settle) + 0.15 * settle;
    this.legs[0].rz = -0.15 * (1 - slam * 0.4) * (1 - settle);
    this.legs[1].rz = 0.15 * (1 - slam * 0.4) * (1 - settle);
    this.legs[2].rx = (0.75 - 1.05 * slam) * (1 - settle) - 0.1 * settle;
    this.legs[3].rx = (0.75 - 1.05 * slam) * (1 - settle) - 0.1 * settle;
    if (this.tail) this.tail.ry = Math.sin(t * 16) * 0.4 * (1 - settle);
  }

  private floodExhale(t: number, dur: number): void {
    const k = smooth01(ramp(t, 0, Math.max(0.3, dur)));
    const decay = 1 - k;
    const breath = Math.sin(t * 9.5) * decay;
    this.body.rx = 0.25 * decay;
    this.body.py = -0.1 * decay + breath * 0.02;
    this.body.pz = 0;
    this.body.s = 1 + 0.05 * breath;
    this.body.rz = breath * 0.02;
    this.head.rx = 0.3 * decay;
    this.head.py = -0.03 * decay;
    this.head.s = 1 + 0.04 * Math.max(0, breath);
    this.jaw.rx = 0.6 * (1 - easeOutCubic(ramp(t, 0, 0.55)));
    this.legs[0].rx = 0.15 * decay;
    this.legs[1].rx = 0.15 * decay;
    this.legs[2].rx = -0.1 * decay;
    this.legs[3].rx = -0.1 * decay;
    if (this.tail) this.tail.ry = Math.sin(t * 6) * 0.3 * decay;
  }

  /** Bobbing (v1.8): a slow heave and roll, plod-paddling legs, jaw shut, the propeller tail churning. */
  protected override poseSwim(speed: number, t: number, mv: number): void {
    super.poseSwim(speed, t, mv);
    const w = t * SWIM_BOB_W;
    this.body.py = Math.sin(w) * this.swim.bob + Math.sin(this.swimPhase * 2) * 0.012 * mv;
    this.body.rx = Math.sin(w * 0.5 + 0.7) * 0.035 - this.swim.pitch * mv;
    this.body.rz = Math.sin(w * 0.5) * 0.03 + Math.sin(this.swimPhase) * 0.04 * mv;
    this.head.rx = -0.1 + Math.sin(w + 0.4) * 0.03;
    this.jaw.rx = 0.03 + Math.max(0, Math.sin(t * 0.9)) * 0.1; // a lazy blow
    if (this.tail) this.tail.ry = Math.sin(t * 5.5) * 0.7 * (0.4 + 0.6 * mv);
  }

  protected poseBlock(t: number): void {
    // Present the forehead: head down, maw clamped, legs planted wide.
    this.body.py = -0.1;
    this.body.rx = 0.1 + Math.sin(t * 2) * 0.01;
    this.head.rx = 0.45;
    this.jaw.rx = 0;
    this.legs[0].rx = -0.25;
    this.legs[1].rx = -0.25;
    this.legs[2].rx = 0.25;
    this.legs[3].rx = 0.25;
  }
}
