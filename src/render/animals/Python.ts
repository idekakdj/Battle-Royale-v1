/**
 * PYTHON — "The Constrictor" (§8 #8). A coiled body with an articulated
 * raised neck chain — long thin jab strikes (3.2 m reach), the 360° Coil
 * Sweep special, and the Constrictor's Embrace wrap ultimate.
 */

import type * as THREE from 'three';
import { ANIMALS } from '../../config/animals';
import type { FighterState } from '../../core/types';
import { BaseRig, type Joint, attackCurve, ramp, smooth01, easeInOutCubic, IMPACT } from './Animator';
import { makeMat, mesh, pivot, boxGeo, sphGeo, capGeo } from './parts';

// Rest curvature of the neck chain (leaning back, ready to strike).
const NECK_REST = [-0.55, 0.2, 0.38, 0.42];

export class PythonRig extends BaseRig {
  private readonly coil: Joint;
  private readonly neckJ: Joint[] = [];
  private readonly jaw: Joint;
  private readonly tailTip: Joint;
  private readonly tongue: Joint;

  constructor() {
    super(ANIMALS.python);
    this.hipDrop = 0.1;
    this.strideRate = 0.4;
    const p = this.pal;
    const mBody = makeMat(p.accent);
    const mDark = makeMat(p.dark);
    const mPat = makeMat(p.darker);
    const mBelly = makeMat(p.belly);
    const mBlack = makeMat(p.eye);
    const mTongue = makeMat(0xc4364d);

    const bodyN = pivot(0, 0, 0);
    this.bodyRoot.add(bodyN);

    // Coiled base: a two-and-a-half-turn spiral of spheres.
    const coilN = pivot(0, 0.16, -0.05);
    bodyN.add(coilN);
    const turns = 9;
    for (let i = 0; i < turns; i++) {
      const a = i * 0.72;
      const r = 0.44 - i * 0.027;
      const y = i * 0.063;
      const seg = mesh(sphGeo(0.18 - i * 0.005, 5, 4), i % 3 === 2 ? mPat : mBody, Math.sin(a) * r, y, Math.cos(a) * r - 0.05);
      seg.scale.set(1.3, 0.95, 1.3);
      coilN.add(seg);
    }
    // Belly plate hint under the coil.
    const base = mesh(sphGeo(0.42, 7, 4), mBelly, 0, 0.02, -0.05);
    base.scale.set(1.15, 0.35, 1.15);
    coilN.add(base);

    // Tail tip trailing out of the coil.
    const tailN = pivot(0.35, 0.08, -0.42);
    tailN.rotation.y = -2.4;
    bodyN.add(tailN);
    const tailSeg = mesh(capGeo(0.06, 0.5, 4), mDark, 0, 0, 0.28);
    tailSeg.rotation.x = Math.PI / 2;
    tailN.add(tailSeg);

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
      const segM = mesh(capGeo(0.125 - i * 0.012, segLen * 0.85, 4), i % 2 === 1 ? mPat : mBody, 0, segLen / 2, 0);
      chain[i].add(segM);
    }

    // Head: flattened wedge + jaw + tongue.
    const headN = pivot(0, segLen + 0.05, 0);
    headN.rotation.x = 1.15; // level the head out of the leaning chain
    parent.add(headN);
    const skull = mesh(sphGeo(0.16, 6, 4), mDark, 0, 0.02, 0.05);
    skull.scale.set(1.15, 0.7, 1.5);
    headN.add(skull);
    headN.add(mesh(sphGeo(0.035, 4, 3), mBlack, -0.09, 0.07, 0.1));
    headN.add(mesh(sphGeo(0.035, 4, 3), mBlack, 0.09, 0.07, 0.1));
    const jawN = pivot(0, -0.05, 0.0);
    headN.add(jawN);
    const jawM = mesh(sphGeo(0.12, 6, 4), mBody, 0, -0.01, 0.08);
    jawM.scale.set(1.1, 0.45, 1.5);
    jawN.add(jawM);
    const tongueN = pivot(0, -0.01, 0.26);
    headN.add(tongueN);
    tongueN.add(mesh(boxGeo(0.02, 0.008, 0.22), mTongue, 0, 0, 0.11));
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

  protected poseUltimate(u: number, _state: FighterState): void {
    // Constrictor's Embrace: huge open-jawed lunge, jaws meeting at 55%.
    const s = attackCurve(u);
    const ext = Math.max(0, s);
    this.neckExtend(ext * 1.1);
    this.body.pz = 0.5 * ext;
    const open = ramp(u, 0.1, 0.4);
    const close = ramp(u, 0.46, IMPACT);
    this.jaw.rx = 1.1 * open * (1 - close);
    this.coil.s = 1 - 0.06 * ext;
  }

  protected override poseGrab(_u: number, _state: FighterState): void {
    // Wrapped around the victim: rhythmic squeezing, head weaving for grip.
    const t = this.timePhase;
    const squeeze = 1 + Math.sin(t * 7) * 0.05;
    this.coil.s = squeeze;
    this.coil.py = 0.06;
    for (let i = 0; i < 4; i++) {
      this.neckJ[i].rx = 0.3 + Math.sin(t * 7 + i) * 0.08;
      this.neckJ[i].ry = Math.sin(t * 3 + i * 1.2) * 0.25;
    }
    this.head.ry = Math.sin(t * 4) * 0.3;
    this.jaw.rx = 0.15;
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
