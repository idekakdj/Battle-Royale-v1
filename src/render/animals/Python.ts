/**
 * PYTHON — "The Constrictor" (§8 #8). A coiled body with an articulated
 * raised neck chain — long thin jab strikes (3.2 m reach), the 360° Coil
 * Sweep special, and the Constrictor's Embrace wrap ultimate.
 *
 * v1.1: one continuous smooth coil (tube along a rising spiral) instead of a
 * stack of balls, python saddle blotches with pale rims and a cream belly,
 * wedge head with heat pits, amber slit-pupil eyes, nostrils and a forked
 * flickering tongue.
 */

import * as THREE from 'three';
import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, ramp, smooth01, easeInOutCubic, IMPACT } from './Animator';
import { SWIM_BOB_W } from './swim';
import { PythonUltPose } from './ultPose/python';
import {
  makeMat,
  mesh,
  part,
  pivot,
  boxGeo,
  sphGeo,
  capGeo,
  coneGeo,
  eye,
  noTone,
  noOutline,
  paint,
  cellular,
  col,
  mixColor,
  shade,
} from './parts';

// Rest curvature of the neck chain (leaning back, ready to strike).
const NECK_REST = [-0.55, 0.2, 0.38, 0.42];

export class PythonRig extends BaseRig {
  private readonly coil: Joint;
  private readonly neckJ: Joint[] = [];
  private readonly jaw: Joint;
  private readonly tailTip: Joint;
  private readonly tongue: Joint;
  /** Coil Snare pose driver (phase/stage-driven, see ultPose/python.ts). */
  private readonly ultPose = new PythonUltPose();
  private ultDt = 1 / 60;

  constructor() {
    super(ANIMALS.python);
    this.hipDrop = 0.1;
    this.strideRate = 0.4;
    this.stepScale = 0;
    this.toneBack = 0.14;
    this.toneBelly = 0.1;
    this.slams = [{ action: 'special', at: IMPACT, radius: 2.2, kind: 'ring', forward: 0 }];
    const p = this.pal;
    const scale = mixColor(p.accent, 0x6b7a3a, 0.3);
    const mBody = makeMat(scale);
    const mDark = makeMat(shade(scale, -0.3));
    const mHead = makeMat(shade(scale, -0.12));
    const mTongue = makeMat(0xc4364d);
    const mPit = makeMat(0x1e2014);

    const blotch = col(shade(scale, -0.62));
    const rim = col(mixColor(scale, 0xe6d9a0, 0.45));
    const belly = col(mixColor(p.belly, 0xefe2b4, 0.6));
    const cell: [number, number] = [0, 0];
    const skin = (pp: THREE.Vector3, n: THREE.Vector3, c: THREE.Color): void => {
      if (n.y < -0.45) {
        c.copy(belly);
        if (Math.abs(Math.sin((pp.x + pp.z) * 30)) < 0.2) c.multiplyScalar(0.86);
        return;
      }
      cellular(pp.x * 1.1, pp.y * 1.6, pp.z * 1.1, 0.16, cell);
      if (cell[0] < 0.06) c.copy(blotch);
      else if (cell[0] < 0.08) c.copy(rim);
    };

    const bodyN = pivot(0, 0, 0);
    this.bodyRoot.add(bodyN);

    // Coiled base: one continuous tube spiralling up and inward.
    const coilN = pivot(0, 0.16, -0.05);
    bodyN.add(coilN);
    const pts: THREE.Vector3[] = [];
    const a0 = 2.39;
    const N = 22;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const a = a0 - t * 2.25 * Math.PI * 2;
      const r = 0.5 - 0.22 * t;
      pts.push(new THREE.Vector3(Math.sin(a) * r, -0.02 + 0.33 * t, Math.cos(a) * r - 0.05));
    }
    pts.push(new THREE.Vector3(0.05, 0.42, 0.02));
    pts.push(new THREE.Vector3(0, 0.52, 0.05));
    const curve = new THREE.CatmullRomCurve3(pts);
    coilN.add(paint(mesh(new THREE.TubeGeometry(curve, 44, 0.165, 7, false), mBody), skin));
    coilN.add(part(sphGeo(0.165, 7, 5), mBody, pts[0].x, pts[0].y, pts[0].z)); // cap the tube end
    // Belly plate under the coil.
    coilN.add(part(sphGeo(0.42, 8, 4), mDark, 0, -0.04, -0.05, 1.15, 0.28, 1.15));

    // Tail tip trailing out of the coil.
    const tailN = pivot(0.35, 0.08, -0.42);
    tailN.rotation.y = -2.4;
    bodyN.add(tailN);
    tailN.add(paint(part(coneGeo(0.13, 0.62, 7), mBody, 0, 0, 0.28, 1, 1, 0.85, Math.PI / 2), skin));

    // Articulated neck chain rising from the coil, ending in the head.
    let parent: THREE.Group;
    const chainRoot = pivot(0, 0.55, 0.05);
    chainRoot.rotation.x = NECK_REST[0];
    coilN.add(chainRoot);
    parent = chainRoot;
    const segLen = 0.34;
    const chain: THREE.Group[] = [chainRoot];
    for (let i = 1; i < 4; i++) {
      const g = pivot(0, segLen, 0);
      g.rotation.x = NECK_REST[i];
      parent.add(g);
      chain.push(g);
      parent = g;
    }
    for (let i = 0; i < 4; i++) {
      const segM = part(capGeo(0.13 - i * 0.012, segLen * 0.85, 7), mBody, 0, segLen / 2, 0, 1, 1, 0.92);
      chain[i].add(paint(segM, skin));
    }

    // Head: flattened wedge + jaw + forked tongue.
    const headN = pivot(0, segLen + 0.05, 0);
    headN.rotation.x = 1.15; // level the head out of the leaning chain
    parent.add(headN);
    headN.add(part(sphGeo(0.16, 9, 6), mHead, 0, 0.02, 0.05, 1.15, 0.66, 1.5)); // skull
    headN.add(part(sphGeo(0.1, 8, 5), mHead, 0, 0.0, 0.22, 1.05, 0.6, 1.1)); // snout
    headN.add(part(sphGeo(0.07, 6, 4), mDark, 0, 0.085, 0.02, 1.6, 0.35, 1.6)); // crown scales
    for (const sx of [-1, 1]) {
      const e = eye({ r: 0.034, iris: 0xd9a030, side: sx, lateral: 0.85, slit: true });
      e.position.set(sx * 0.1, 0.05, 0.1);
      headN.add(e);
      headN.add(noOutline(noTone(part(sphGeo(0.015, 4, 2), mPit, sx * 0.045, 0.03, 0.31))));
      for (let k = 0; k < 3; k++) {
        headN.add(noOutline(noTone(part(sphGeo(0.013, 4, 2), mPit, sx * (0.09 + k * 0.012), -0.02, 0.24 - k * 0.05))));
      }
    }
    const jawN = pivot(0, -0.05, 0.0);
    headN.add(jawN);
    jawN.add(part(sphGeo(0.12, 8, 4), mBody, 0, -0.01, 0.1, 1.1, 0.42, 1.55));
    const tongueN = pivot(0, -0.01, 0.26);
    headN.add(tongueN);
    tongueN.add(noOutline(noTone(mesh(boxGeo(0.018, 0.008, 0.18), mTongue, 0, 0, 0.09))));
    tongueN.add(noOutline(noTone(part(boxGeo(0.012, 0.007, 0.07), mTongue, -0.012, 0, 0.2, 1, 1, 1, 0, -0.35))));
    tongueN.add(noOutline(noTone(part(boxGeo(0.012, 0.007, 0.07), mTongue, 0.012, 0, 0.2, 1, 1, 1, 0, 0.35))));
    tongueN.scale.setScalar(0.001); // hidden until flicked

    this.body = this.joint(bodyN);
    this.coil = this.joint(coilN);
    for (const g of chain) this.neckJ.push(this.joint(g));
    this.head = this.joint(headN);
    this.jaw = this.joint(jawN);
    this.tailTip = this.joint(tailN);
    this.tongue = this.joint(tongueN);
    this.finalize();
  }

  /** Straighten (+1) or deepen (−1) the neck's rest curve toward a strike line. */
  private neckExtend(k: number): void {
    this.neckJ[0].rx = (1.55 - NECK_REST[0]) * 0.55 * k; // pitch chain forward
    for (let i = 1; i < 4; i++) this.neckJ[i].rx = -NECK_REST[i] * k;
    this.head.rx = -0.55 * k;
  }

  protected poseIdle(t: number): void {
    // Swaying raised neck, breathing coil, tongue flicks.
    for (let i = 0; i < 4; i++) this.neckJ[i].ry = Math.sin(t * 0.8 - i * 0.5) * 0.12;
    this.neckJ[0].rx = Math.sin(t * 0.5) * 0.06;
    this.coil.s = 1 + Math.sin(t * 1.4) * 0.012;
    this.head.ry = Math.sin(t * 0.6) * 0.2;
    const flick = smooth01(Math.sin(t * 2.1) * 6 - 5);
    this.tongue.s = 0.001 + flick * (1 + Math.sin(t * 26) * 0.3);
    this.tailTip.ry = Math.sin(t * 0.9) * 0.3;
  }

  protected poseRun(speed: number): void {
    // Serpentine slither: traveling lateral wave down the whole chain.
    const k = Math.min(1, speed / this.def.speed);
    const g = this.gaitPhase;
    this.body.ry = Math.sin(g) * 0.14 * k;
    this.body.px = Math.sin(g + 0.6) * 0.1 * k;
    this.coil.rz = Math.sin(g) * 0.05 * k;
    this.coil.py = Math.abs(Math.sin(g * 0.5)) * 0.02 * k;
    for (let i = 0; i < 4; i++) this.neckJ[i].ry = Math.sin(g - i * 0.9) * 0.22 * k;
    this.neckJ[0].rx = 0.12 * k; // lean into the motion
    this.head.ry = Math.sin(g - 3.6) * 0.15 * k;
    this.tailTip.ry = Math.sin(g + 1.2) * 0.6 * k;
  }

  protected poseAttack(n: 1 | 2 | 3, u: number): void {
    // Long thin jabs: recoil deeper into the coil, then spear out — full
    // extension exactly at 55%. Variants aim low / high / wide-jawed.
    const s = attackCurve(u);
    const ext = Math.max(0, s);
    const rec = Math.max(0, -s) / 0.45;
    this.neckExtend(ext);
    this.neckJ[0].rx += 0.25 * rec - (n === 1 ? 0.15 : 0) * ext;
    if (n === 2) this.head.rx += -0.25 * ext; // high jab
    this.body.pz = 0.3 * ext;
    this.coil.s = 1 + 0.05 * rec - 0.04 * ext;
    const open = ramp(u, 0.2, 0.42);
    const close = ramp(u, 0.47, IMPACT);
    this.jaw.rx = (n === 3 ? 0.9 : 0.5) * open * (1 - close);
    this.tailTip.ry = -0.4 * s;
  }

  protected poseSpecial(u: number, _state: FighterState): void {
    // Coil Sweep: neck drops low and the whole snake whirls a full turn,
    // the sweep passing the front exactly at the impact instant.
    const k = smooth01(ramp(u, 0, 0.25)) * (1 - smooth01(ramp(u, 0.85, 1)));
    this.neckJ[0].rx = 0.9 * k; // neck swung down horizontal
    this.neckJ[1].rx = -0.2 * k;
    this.head.rx = -0.9 * k;
    this.body.ry = Math.PI * 2 * easeInOutCubic(ramp(u, 0.1, 1.0));
    this.coil.py = -0.05 * k;
    this.jaw.rx = 0.3 * k;
  }

  override update(state: FighterState, dtRender: number): void {
    this.ultDt = dtRender < 0 ? 0 : dtRender > 0.1 ? 0.1 : dtRender;
    super.update(state, dtRender);
  }

  protected poseUltimate(_u: number, state: FighterState): void {
    // Coil Snare (v1.3): cobra rear + hiss -> tether lash -> yank -> staged wraps tightening per
    // ultimateStage with squeeze pulses -> crush -> settle. All from ultPhase / ultStage / actionT
    // (ultPose/python.ts); the action stays 'ultimate' throughout.
    this.ultPose.update(state, this.ultDt, {
      body: this.body,
      coil: this.coil,
      neck: this.neckJ,
      head: this.head,
      jaw: this.jaw,
      tailTip: this.tailTip,
      tongue: this.tongue,
    });
  }

  /** S-undulation (v1.8): a lateral wave runs through the coil and the neck chain, the head held up, the tail tip lashing. */
  protected override poseSwim(_speed: number, t: number, mv: number): void {
    const ph = this.swimPhase;
    const a = 0.55 + 0.45 * mv;
    this.body.ry = Math.sin(ph) * 0.12 * a;
    this.body.px = Math.sin(ph + 0.6) * 0.08 * a;
    this.body.py = Math.sin(t * SWIM_BOB_W) * this.swim.bob;
    this.coil.rz = Math.sin(ph) * 0.07 * a;
    this.coil.s = 1 + Math.sin(t * 1.4) * 0.012;
    // The neck leans far forward (the head ~0.8 m over the water, not a periscope); the rest curve + the S-wave do the rest.
    this.neckJ[0].rx = 0.95 + Math.sin(t * 0.5) * 0.05 + 0.1 * mv;
    for (let i = 1; i < 4; i++) this.neckJ[i].rx = -NECK_REST[i] * 0.2;
    this.head.rx = -0.2;
    for (let i = 0; i < 4; i++) this.neckJ[i].ry = Math.sin(ph - i * 0.9) * 0.38 * a;
    this.head.ry = Math.sin(ph - 3.6) * 0.2 * a;
    this.tailTip.ry = Math.sin(ph + 1.2) * 0.8 * a;
    const flick = smooth01(Math.sin(t * 2.1) * 6 - 5);
    this.tongue.s = 0.001 + flick * (1 + Math.sin(t * 26) * 0.3);
  }

  /** The S-wave keeps rolling through the body while the neck strikes (v1.8). */
  protected override poseSwimAttack(_n: 1 | 2 | 3, _u: number, _uw: number): void {
    const ph = this.swimPhase;
    this.body.ry += Math.sin(ph) * 0.07;
    this.coil.rz += Math.sin(ph) * 0.04;
    this.tailTip.ry += Math.sin(ph + 1.2) * 0.5;
  }

  protected poseBlock(t: number): void {
    // Pull tight: head withdrawn behind the coil, tension stored (§8 perk).
    this.neckJ[0].rx = -0.35;
    this.neckJ[1].rx = 0.3;
    this.neckJ[2].rx = 0.35;
    this.head.rx = 0.3;
    this.head.py = -0.05;
    this.coil.s = 1.06 + Math.sin(t * 3) * 0.01;
    this.coil.py = -0.03;
  }

  protected override poseKnockdown(u: number): void {
    const fall = smooth01(ramp(u, 0, 0.18));
    const rise = smooth01(ramp(u, 0.72, 1));
    const k = fall * (1 - rise);
    // Neck slumps flat rather than the body tipping.
    this.neckJ[0].rx = 1.35 * k;
    this.neckJ[1].rx = 0.2 * k;
    this.head.rx = -0.8 * k;
    this.coil.py = -0.08 * k;
    this.coil.s = 1 + 0.08 * k;
  }

  protected override poseDead(): void {
    const t = this.deathT;
    const k = smooth01(Math.min(1, t / 0.6));
    this.neckJ[0].rx = 1.5 * k;
    this.neckJ[1].rx = 0.25 * k;
    this.head.rx = -1.0 * k;
    this.head.rz = 0.4 * k;
    this.jaw.rx = 0.35 * k;
    this.coil.py = -0.1 * k;
    this.coil.s = 1 + 0.12 * k; // slumps and spreads
  }

  protected override poseGrabbed(t: number): void {
    this.coil.py = 0.15;
    this.coil.s = 0.92;
    for (let i = 0; i < 4; i++) this.neckJ[i].ry = Math.sin(t * 11 + i) * 0.2;
    this.head.rx = 0.3;
  }

  protected override poseFeared(speed: number): void {
    this.poseRun(Math.max(speed, this.def.speed));
    this.head.ry += Math.sin(this.timePhase * 14) * 0.3;
    this.neckJ[0].rx += 0.3; // cowering low
  }
}
