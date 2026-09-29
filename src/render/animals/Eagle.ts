/**
 * EAGLE — "The Sky Terror" (§8 #6). Wings + tail-fan silhouette, white head,
 * hooked beak. Talon rakes and Beak Pierce combo, Gale Burst wing-sweep
 * special, Death From Above soar-and-dive ultimate, and the glide/soar (§7.8).
 *
 * v1.1: layered wings (covert shell + overlapping secondaries + fanned
 * primaries), scalloped body plumage, white head with a fierce brow, yellow
 * cere and hooked beak, golden eyes, a fanned white tail, feathered "trousers"
 * over scaly yellow legs and black talons.
 *
 * v1.2 (WP-O): the wing joints now REST at full span (identity rotation) and
 * every pose folds them explicitly through {@link EagleRig.wingPose}. The old
 * rig rested folded and its `wings(1)` ADDED the fold instead of cancelling
 * it (sign error), so "full-span" glides actually wrapped the wings twice as
 * far round the body. Each primary is its own joint so the wingtip "fingers"
 * fan out in flight, and the tail fan opens with two side joints. The flight
 * pose (glide / climb-flap / max-height hover-bank / fast-fall stoop / landing
 * flare) is blended purely from FighterState (action, pos.y, vel, yaw).
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

// Folded-wing angles (frontal-plane fold, as the v1.1 rest pose).
const FOLD_IN = 1.05;
const FOLD_OUT = 2.05;
/** Primary-feather "finger" fan at full spread, radians outward from straight back (inner → outer). */
const PRIM_FAN: readonly number[] = [0.1, 0.36, 0.62, 0.88, 1.14];
/** Tail-fan half-spread added at full fan (per side pivot). */
const TAIL_FAN = 0.34;
/** Body pitch (forward) of the level glide. */
const GLIDE_BX = 0.62;

/** Flight pose parameters (world-relative angles are converted per joint). */
interface FlightParams {
  spread: number;
  flap: number;
  sweep: number;
  tip: number;
  fan: number;
  /** Wing-plane pitch in the root frame (− = leading edge up). */
  wingPitch: number;
  bodyRx: number;
  bodyRz: number;
  bodyPy: number;
  /** Head / legs / tail pitch in the root frame. */
  headRx: number;
  legRx: number;
  tailRx: number;
  tailFan: number;
  /** Torso-shell long-axis tilt in the root frame (+ = front down). */
  torsoRx: number;
}

/** The torso shell's built-in forward tilt (see the body ellipsoid). */
const TORSO_REST = 0.45;

function zeroParams(): FlightParams {
  return {
    spread: 0, flap: 0, sweep: 0, tip: 0, fan: 0, wingPitch: 0,
    bodyRx: 0, bodyRz: 0, bodyPy: 0, headRx: 0, legRx: 0, tailRx: 0, tailFan: 0, torsoRx: 0,
  };
}

function addParams(out: FlightParams, w: number, p: FlightParams): void {
  if (w <= 0) return;
  out.spread += p.spread * w;
  out.flap += p.flap * w;
  out.sweep += p.sweep * w;
  out.tip += p.tip * w;
  out.fan += p.fan * w;
  out.wingPitch += p.wingPitch * w;
  out.bodyRx += p.bodyRx * w;
  out.bodyRz += p.bodyRz * w;
  out.bodyPy += p.bodyPy * w;
  out.headRx += p.headRx * w;
  out.legRx += p.legRx * w;
  out.tailRx += p.tailRx * w;
  out.tailFan += p.tailFan * w;
  out.torsoRx += p.torsoRx * w;
}

function clearParams(p: FlightParams): void {
  p.spread = p.flap = p.sweep = p.tip = p.fan = p.wingPitch = 0;
  p.bodyRx = p.bodyRz = p.bodyPy = p.headRx = p.legRx = p.tailRx = p.tailFan = p.torsoRx = 0;
}

export class EagleRig extends BaseRig {
  private readonly wingLIn: Joint;
  private readonly wingLOut: Joint;
  private readonly wingRIn: Joint;
  private readonly wingROut: Joint;
  private readonly primL: Joint[];
  private readonly primR: Joint[];
  private readonly tailFan: Joint;
  private readonly tailL: Joint;
  private readonly tailR: Joint;
  private readonly torso: Joint;

  // Flight-blend scratch + render-side smoothing (no gameplay state).
  private readonly fp = zeroParams();
  private readonly mode = zeroParams();
  private sClimb = 0;
  private sDive = 0;
  private sFlare = 0;
  private sHigh = 0;
  private sBank = 0;
  private peakY = 0;
  private lastT = 0;

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
    const mPrimTip = makeMat(shade(brown, -0.55));
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
    // Torso shell on its own joint: in flight it levels out along the flight
    // line while the body pivot pitches forward to bring the head ahead.
    const torsoN = pivot(0, 0, 0);
    bodyN.add(torsoN);
    torsoN.add(paint(part(sphGeo(0.3, 10, 7), mBody, 0, 0, 0, 0.85, 1.0, 1.35, 0.45), scallops));
    torsoN.add(paint(part(sphGeo(0.2, 8, 6), mWingLt, 0, -0.1, 0.22, 1, 1, 0.9), scallops)); // chest
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

    // Fanned white tail: centre feathers on the base joint, two side pivots
    // that swing outward to open the fan in flight.
    const tailN = pivot(0, -0.12, -0.32);
    tailN.rotation.x = -0.25;
    bodyN.add(tailN);
    const tailFeather = (host: THREE.Object3D, a: number, i: number, m: THREE.Material): void => {
      const len = 0.44;
      host.add(part(boxGeo(0.09, 0.022, len), m, -Math.sin(a) * len * 0.5, 0.004 * i, -Math.cos(a) * len * 0.5, 1, 1, 1, 0, a));
    };
    tailFeather(tailN, 0, 3, mWhite);
    const tailSide = (side: number): THREE.Group => {
      const g = pivot(0, 0, 0);
      tailN.add(g);
      for (let i = 1; i <= 3; i++) tailFeather(g, -side * i * 0.15, 3 - i, i % 2 === 0 ? mWhite : mWhite2);
      return g;
    };
    const tailLN = tailSide(-1);
    const tailRN = tailSide(1);

    // Layered wings. REST = full span along ±x (identity rotations); poses
    // fold them via wingPose(). Arm (inner) → hand (outer) → 5 primaries.
    const mkWing = (side: number): { inn: Joint; out: Joint; prim: Joint[] } => {
      const inn = pivot(0.19 * side, 0.2, 0.03);
      bodyN.add(inn);
      inn.add(paint(part(sphGeo(0.28, 9, 5), mWingLt, 0.25 * side, 0.012, -0.03, 0.95, 0.13, 0.62), scallops)); // arm coverts
      for (let i = 0; i < 5; i++) {
        // Overlapping secondaries along the trailing edge.
        const x = (0.05 + i * 0.105) * side;
        inn.add(part(boxGeo(0.125, 0.022, 0.42), mWing, x, -0.006 - i * 0.002, -0.22, 1, 1, 1, 0, side * (0.06 - i * 0.025)));
      }
      const out = pivot(0.5 * side, 0, 0);
      inn.add(out);
      out.add(paint(part(sphGeo(0.22, 8, 4), mWing, 0.16 * side, 0.008, -0.03, 1.0, 0.12, 0.62), scallops)); // hand coverts
      const prim: Joint[] = [];
      for (let i = 0; i < 5; i++) {
        const f = pivot((0.1 + i * 0.062) * side, -0.003 * i, 0.03 - i * 0.012);
        out.add(f);
        const len = 0.34 + i * 0.035; // outer primaries are the long "fingers"
        f.add(part(boxGeo(0.078, 0.018, len * 0.72), mPrimary, 0, 0, -len * 0.36));
        f.add(noTone(part(boxGeo(0.06, 0.016, len * 0.34), mPrimTip, 0, -0.002, -len * 0.84)));
        prim.push(this.joint(f));
      }
      return { inn: this.joint(inn), out: this.joint(out), prim };
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
    this.torso = this.joint(torsoN);
    this.head = this.joint(headN);
    this.tailFan = this.joint(tailN);
    this.tailL = this.joint(tailLN);
    this.tailR = this.joint(tailRN);
    this.tail = this.tailFan;
    const wl = mkWing(-1);
    const wr = mkWing(1);
    this.wingLIn = wl.inn;
    this.wingLOut = wl.out;
    this.primL = wl.prim;
    this.wingRIn = wr.inn;
    this.wingROut = wr.out;
    this.primR = wr.prim;
    this.legs = [mkLeg(-1), mkLeg(1)];
    this.finalize();
  }

  // ── Wing / tail helpers ─────────────────────────────────────────────────────

  /**
   * Full wing pose (both sides mirrored).
   * @param spread 0 = folded against the body, 1 = full span
   * @param flap   span angle at full spread: + = tips down (downstroke), − = up (dihedral / upstroke)
   * @param sweep  + = swept back (tuck / stoop), − = swept forward (mantle, Gale Burst hammer)
   * @param pitch  wing-plane pitch about the body x axis, relative to the body (− = leading edge up)
   * @param tip    extra hand bend relative to the arm (+ = tip down; lag it behind the beat for a whip)
   * @param fan    primary "finger" spread 0..1
   */
  private wingPose(spread: number, flap = 0, sweep = 0, pitch = 0, tip = 0, fan = spread): void {
    const down = FOLD_IN * (1 - spread) + flap * spread;
    const bend = FOLD_OUT * (1 - spread) - tip;
    this.wingLIn.rz = down;
    this.wingRIn.rz = -down;
    this.wingLIn.ry = -sweep;
    this.wingRIn.ry = sweep;
    this.wingLIn.rx = pitch;
    this.wingRIn.rx = pitch;
    this.wingLOut.rz = -bend;
    this.wingROut.rz = bend;
    const f = fan < 0 ? 0 : fan > 1 ? 1 : fan;
    for (let i = 0; i < 5; i++) {
      this.primL[i].ry = f * PRIM_FAN[i];
      this.primR[i].ry = -f * PRIM_FAN[i];
    }
  }

  /** Spread the wings: 0 = folded rest, 1 = full span. `flap` adds beat angle. */
  private wings(spread: number, flap = 0): void {
    this.wingPose(spread, flap, 0, 0, 0, spread * 0.6);
  }

  private tailOpen(k: number): void {
    this.tailL.ry = k * TAIL_FAN;
    this.tailR.ry = -k * TAIL_FAN;
  }

  // ── Ground poses ────────────────────────────────────────────────────────────

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
    this.wingPose(0.45 * k, Math.sin(g * 2) * 0.35 * k, 0.25 * k, 0, 0, 0.3 * k);
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
      const a = Math.abs(s);
      this.wingPose(0.85 * a, -0.35 * a + Math.max(0, s) * 0.5, -0.2 * a, 0, -0.2 * a, 0.9 * a);
      this.tailOpen(0.6 * a);
      this.head.rx = 0.2 * s;
    } else {
      // Beak Pierce: coiled neck, spearing lunge at 55%.
      this.head.rx = 0.7 * s;
      this.head.pz = 0.14 * Math.max(0, s);
      this.body.rx = 0.35 * s;
      this.body.pz = 0.2 * Math.max(0, s);
      const a = Math.abs(s);
      this.wingPose(0.55 * a, -0.25 * Math.max(0, s), 0.35 * a, 0, 0, 0.5 * a);
      this.tailFan.rx = -0.3 * s;
    }
  }

  protected poseSpecial(u: number, _state: FighterState): void {
    // Gale Burst: rear up with wings raised high, then hammer both wings
    // down-and-forward at the impact instant.
    const rear = smooth01(ramp(u, 0, 0.35));
    const sweep = impactPulse(u, 0.12);
    this.body.rx = -0.4 * rear * (1 - sweep) + 0.15 * sweep;
    this.body.py = 0.1 * rear;
    this.wingPose(Math.max(rear, sweep), -0.95 * rear * (1 - sweep) + 0.75 * sweep, 0.3 * rear * (1 - sweep) - 0.85 * sweep, -0.3 * rear, -0.3 * rear + 0.4 * sweep, 1);
    this.tailOpen(rear);
    this.head.rx = -0.2 * rear + 0.25 * sweep;
    this.legs[0].rx = 0.4 * rear;
    this.legs[1].rx = 0.4 * rear;
  }

  protected poseUltimate(u: number, state: FighterState): void {
    // Death From Above: powered soar, then fold into the stoop. The sim owns
    // altitude; the pose reads the phase from u and the fall from vel.y.
    if (u < IMPACT) {
      const k = smooth01(ramp(u, 0, 0.2));
      const ph = this.timePhase * 13;
      this.wingPose(k, 0.1 + Math.sin(ph) * 0.75 * k, -0.1 * Math.sin(ph) * k, -0.3 * k, Math.sin(ph - 1) * 0.35 * k, 0.6 + 0.4 * Math.cos(ph));
      this.body.rx = -0.5 * k;
      this.body.py = -Math.sin(ph) * 0.03 * k;
      this.head.rx = 0.45 * k + 0.5 * k; // eyes locked below
      this.legs[0].rx = 0.5 * k;
      this.legs[1].rx = 0.5 * k;
      this.tailFan.rx = 0.35 * k;
      this.tailOpen(k);
    } else {
      const dive = state.vel.y < -1 ? 1 : smooth01(ramp(u, IMPACT, 0.62));
      this.wingPose(0.25 * (1 - dive) + 0.18 * dive, 0.1, 1.1 * dive, 0, 0.25 * dive, 0.05);
      this.body.rx = 0.9 * dive;
      this.head.rx = 0.3 * dive - 0.4 * dive;
      this.legs[0].rx = -1.2 * dive; // talons first
      this.legs[1].rx = -1.2 * dive;
      this.tailOpen(0.1);
    }
  }

  protected poseBlock(t: number): void {
    // Wing shield: mantled forward like guarding a kill.
    this.body.rx = 0.15;
    this.body.py = -0.06 + Math.sin(t * 2) * 0.008;
    this.wingPose(0.72, -0.55, -0.95, -0.2, 0.55, 0.45);
    this.head.rx = 0.3;
    this.head.py = -0.05;
    this.tailOpen(0.4);
  }

  // Generic poses never touched the wings; with the spread rest they must fold.
  protected override poseHit(u: number): void {
    super.poseHit(u);
    const k = 1 - u;
    this.wingPose(0.35 * k, -0.4 * k, 0, 0, 0, 0.5 * k); // startled flare
  }

  protected override poseStagger(u: number): void {
    super.poseStagger(u);
    const w = 1 - u;
    this.wingPose(0.3 * w, Math.sin(u * 18) * 0.3 * w, 0, 0, 0, 0.3 * w);
  }

  protected override poseKnockdown(u: number): void {
    super.poseKnockdown(u);
    const fall = smooth01(ramp(u, 0, 0.16)) * (1 - smooth01(ramp(u, 0.72, 1)));
    this.wingPose(0.3 * fall, 0.6 * fall, 0.3 * fall, 0, 0.3 * fall, 0.2 * fall); // sprawled
  }

  protected override poseDead(): void {
    super.poseDead();
    const k = Math.min(1, this.deathT / 0.5);
    this.wingPose(0.35 * k, 0.9 * k, 0.2 * k, 0, 0.5 * k, 0.3 * k); // one wing splayed on the sand
  }

  protected override poseGrabbed(t: number): void {
    super.poseGrabbed(t);
    this.wingPose(0.4, Math.sin(t * 14) * 0.5, 0, 0, Math.sin(t * 14 - 1) * 0.3, 0.6); // frantic flapping
  }

  // ── Flight ─────────────────────────────────────────────────────────────────

  protected override poseJump(state: FighterState): void {
    this.flight(state, true);
  }

  protected override poseGlide(state: FighterState): void {
    this.flight(state, false);
  }

  /**
   * v1.2 soar animation set, blended from FighterState only:
   *  - level glide: full span, slight dihedral, fanned primaries, lazy rock;
   *  - climb (vel.y > 0): strong flap cycle with a lagging wingtip whip;
   *  - high hover (pos.y > ~4): wings wide, slow deep beats, bank + sway;
   *  - fast fall (vel.y < −6 after a high flight): folded stoop;
   *  - final metre of any descent: landing flare (wings up/back, talons forward).
   * Short hops (`jump` that never got high) keep a more upright body.
   * The mode weights are low-passed on the render side so sim-side velocity
   * steps (e.g. reaching max height) never pop the pose.
   */
  private flight(state: FighterState, jumping: boolean): void {
    const t = this.timePhase;
    let dt = t - this.lastT;
    this.lastT = t;
    const y = state.pos.y;
    const vy = state.vel.y;
    const fresh = dt < 0 || dt > 0.25; // a new flight (we were grounded / in another action)
    if (fresh) {
      this.peakY = y;
      this.sClimb = this.sDive = this.sFlare = this.sHigh = this.sBank = 0;
    }
    if (dt < 0 || dt > 0.1) dt = 0.016;
    if (y > this.peakY) this.peakY = y;

    // Target mode weights.
    const climbT = smooth01((vy - 0.4) / 2.2);
    const high = smooth01((this.peakY - 2.2) / 1.2); // this flight went properly high
    const diveT = smooth01((-vy - 3.5) / 3) * high * smooth01((y - 0.6) / 0.8);
    // Flare over the final metre — or the final ~0.2 s of a fast drop so a
    // 15 m/s landing still shows it.
    const tGround = y / Math.max(0.1, -vy);
    const flareT = Math.max(smooth01((1.15 - y) / 0.75), smooth01((0.24 - tGround) / 0.1)) * smooth01((-vy - 0.2) / 1.2);
    const highT = smooth01((y - 3.4) / 1.1);
    const hop = jumping ? 1 - smooth01((this.peakY - 1.35) / 0.9) : 0;

    // Render-side low-pass (≈ 90 ms) so velocity steps blend smoothly.
    const a = 1 - Math.exp(-dt / 0.09);
    this.sClimb += (climbT - this.sClimb) * a;
    this.sDive += (diveT - this.sDive) * a;
    this.sFlare += (flareT - this.sFlare) * Math.min(1, a * 2.2);
    this.sHigh += (highT - this.sHigh) * a;

    const flare = this.sFlare;
    const wDive = this.sDive * (1 - flare);
    const wClimb = this.sClimb * (1 - flare) * (1 - this.sDive);
    const wHover = this.sHigh * (1 - this.sClimb) * (1 - this.sDive) * (1 - flare);
    const wGlide = Math.max(0, 1 - flare - wDive - wClimb - wHover);

    // Bank from sideways velocity relative to facing (+x local = eagle's left).
    const lat = state.vel.x * Math.cos(state.yaw) - state.vel.z * Math.sin(state.yaw);
    const bankT = Math.max(-0.42, Math.min(0.42, -lat * 0.075));
    this.sBank += (bankT - this.sBank) * a;

    const out = this.fp;
    clearParams(out);
    const m = this.mode;

    // Level glide.
    m.spread = 1; m.flap = -0.15 + Math.sin(t * 1.3) * 0.025; m.sweep = 0.05; m.tip = -0.07; m.fan = 1;
    m.wingPitch = -0.08; m.bodyRx = GLIDE_BX; m.bodyRz = Math.sin(t * 1.6) * 0.07; m.bodyPy = Math.sin(t * 1.6 + 1) * 0.015;
    m.headRx = 0.14; m.legRx = 1.35; m.tailRx = 0.06; m.tailFan = 0.7; m.torsoRx = 0.1;
    addParams(out, wGlide, m);

    // Climb: strong flap cycle.
    const pc = t * 10.5;
    const sc = Math.sin(pc);
    m.spread = 1; m.flap = 0.12 + 0.72 * sc; m.sweep = 0.05 - 0.14 * sc; m.tip = 0.38 * Math.sin(pc - 1.0); m.fan = 0.72 + 0.28 * Math.cos(pc);
    m.wingPitch = -0.3 - 0.2 * Math.cos(pc); m.bodyRx = GLIDE_BX - 0.4; m.bodyRz = 0; m.bodyPy = -0.035 * sc;
    m.headRx = 0; m.legRx = 1.15; m.tailRx = 0.22; m.tailFan = 1; m.torsoRx = -0.22;
    addParams(out, wClimb, m);

    // High hover / bank: wings wide, slow deep beats, lazy sway.
    const ph = t * 3.3;
    const sh = Math.sin(ph);
    m.spread = 1; m.flap = -0.08 + 0.4 * sh; m.sweep = -0.06; m.tip = 0.22 * Math.sin(ph - 0.8); m.fan = 1;
    m.wingPitch = -0.35; m.bodyRx = GLIDE_BX - 0.5; m.bodyRz = Math.sin(t * 0.8) * 0.13; m.bodyPy = -0.02 * sh;
    m.headRx = 0.4; m.legRx = 0.95; m.tailRx = 0.28; m.tailFan = 1; m.torsoRx = -0.15;
    addParams(out, wHover, m);

    // Fast-fall stoop: wings pulled in and swept back, head-first.
    m.spread = 0.2; m.flap = 0.1; m.sweep = 1.05 + Math.sin(t * 38) * 0.03; m.tip = 0.2; m.fan = 0.05;
    m.wingPitch = 0; m.bodyRx = GLIDE_BX + 0.55; m.bodyRz = 0; m.bodyPy = 0;
    m.headRx = 0.3; m.legRx = 1.55; m.tailRx = 0; m.tailFan = 0.1; m.torsoRx = 0.95;
    addParams(out, wDive, m);

    // Landing flare: body upright, wings raised and cupped back, talons forward.
    const pf = t * 13;
    m.spread = 1; m.flap = -0.62 + 0.16 * Math.sin(pf); m.sweep = 0.18; m.tip = -0.2 + 0.12 * Math.sin(pf - 0.8); m.fan = 1;
    m.wingPitch = -0.95; m.bodyRx = -0.28; m.bodyRz = 0; m.bodyPy = 0.02;
    m.headRx = 0.25; m.legRx = -0.95; m.tailRx = 0.65; m.tailFan = 1; m.torsoRx = -0.5;
    addParams(out, flare, m);

    // Short hop: more upright body, legs hang, wings a little higher.
    if (hop > 0) {
      const k = hop * (1 - flare);
      out.torsoRx -= k * (out.torsoRx - (TORSO_REST + 0.12));
      out.bodyRx -= hop * (out.bodyRx - 0.12) * (1 - flare);
      out.legRx -= hop * (out.legRx - 0.5) * (1 - flare);
      out.flap -= hop * 0.12;
      out.tailFan *= 1 - hop * 0.4;
    }
    out.bodyRz += this.sBank * (1 - wDive - flare);

    // Write joints (world-relative angles → joint-local).
    const bx = out.bodyRx;
    this.body.rx = bx;
    this.body.rz = out.bodyRz;
    this.body.py = out.bodyPy;
    this.torso.rx = out.torsoRx - TORSO_REST - bx;
    this.head.rx = out.headRx - bx;
    this.legs[0].rx = out.legRx - bx;
    this.legs[1].rx = out.legRx - bx;
    this.tailFan.rx = out.tailRx - bx + 0.25; // cancel the tail's −0.25 rest tilt
    this.tailOpen(out.tailFan);
    this.wingPose(out.spread, out.flap, out.sweep, out.wingPitch - bx, out.tip, out.fan);
  }
}
