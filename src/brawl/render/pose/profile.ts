/**
 * Per-animal limb-role PROFILES: how the canonical DOFs (dof.ts) map onto one rig's joints.
 *
 * A profile is data: `links[dof]` = list of `{ j: joint name, ch: channel, k: coefficient }`. The rig joint's channel
 * receives `k × dofValue` (radians for r*, metres for p*, scale delta for s). Joint names are the property names the rig
 * class stores its joints under (`BaseRig.brawlJoints()`: `body`, `head`, `jaw`, `legs.0`, `armL`, `foreL`, …).
 *
 * Profiles are written for the `facing +1` frame: `Near` limbs are the rig's local −X side (the camera side when the
 * fighter faces right). `mirror` lists the joint pairs that swap places when the fighter faces left (centre-line joints
 * mirror in place); the rotation channels ry/rz and the px offset flip sign in the mirrored pose.
 */

import * as THREE from 'three';
import type { AnimalId } from '../../../core/types';
import type { ArchetypeId, MoveBody } from '../../types';
import { DOF, DOF_N, type DofName, type DofPartial, type DofVec } from './dof';
import type { Joint } from '../../../render/animals/Animator';
import type { StateCtx } from './states';
import type { Ease } from './timeline';

/** A profile's per-state DOF overlay: a constant, or a pure function of the state context (WP-A3). */
export type StateExtra = DofPartial | ((c: StateCtx) => DofPartial);

export type JointCh = 'rx' | 'ry' | 'rz' | 'px' | 'py' | 'pz' | 's';
const CH_INDEX: Record<JointCh, number> = { rx: 0, ry: 1, rz: 2, px: 3, py: 4, pz: 5, s: 6 };
/** Channels that change sign in the mirrored (facing −1) pose. */
const MIRROR_SIGN: readonly number[] = [1, -1, -1, -1, 1, 1, 1];

export interface DofLink {
  /** Joint name (see `BaseRig.brawlJoints()`). */
  j: string;
  ch: JointCh;
  /** Joint channel += k × DOF value. */
  k: number;
}

/** The striking end of a limb role: a joint plus a local offset (rig metres in that joint's frame). */
export interface TipDef {
  j: string;
  off: readonly [number, number, number];
}

export type TipRole = 'foreNear' | 'foreFar' | 'hindNear' | 'hindFar' | 'head' | 'jaw' | 'tail' | 'wingNear' | 'wingFar' | 'body';
export const TIP_ROLES: readonly TipRole[] = ['foreNear', 'foreFar', 'hindNear', 'hindFar', 'head', 'jaw', 'tail', 'wingNear', 'wingFar', 'body'];

/** Anatomical limits per DOF (solver bounds; archetype bounds are intersected with these). */
export type DofLimits = Partial<Record<DofName, readonly [number, number]>>;

// ── Archetype generator contract (see archetypes.ts) ───────────────────────────

export interface FreeVar {
  d: DofName;
  lo: number;
  hi: number;
  /** DOFs that receive the same value as `d` (e.g. both forelimbs of a slam). */
  tie?: readonly DofName[];
}

export interface ArchSpec {
  /** Tip role that must reach the hitbox during the active frames. */
  tip: TipRole;
  /** Strike pose template (facing +1, striking limb = near unless `swap`). Free variables are solved for the target. */
  B: DofPartial;
  free: FreeVar[];
  /** Anticipation pose (a function of the solved strike pose). */
  A: (B: DofVec) => DofPartial;
  /** Extra keys before the strike (`before` frames earlier than the first active frame). */
  pre?: { before: number; v: (B: DofVec) => DofPartial }[];
  /** Added across the active window: pose at the last active frame = strike pose + drift (spins, sweeps). */
  drift?: DofPartial;
  /** Follow-through overshoot beyond the strike pose, as a fraction of the strike travel (default 0.1). */
  over?: number;
  /** The striking limb is the FAR one: the finished pose is side-swapped. */
  swap?: boolean;
  /** Final pose at the end of the move (default rest). Spins end a full turn later (`bodyYaw: 2π` ≡ 0). */
  end?: DofPartial;
  /** Fraction of the recovery the follow-through takes (default 0.2). */
  ftFrac?: number;
  /** Do not solve for the hitbox (tip checks are skipped for this move). */
  noFit?: boolean;
  /**
   * WP-A3 (additive): extra keys INSIDE the active window — DOF deltas added on top of the last solved strike pose, `at` frames
   * after the first active frame (periodic wing beats, squeeze pulses). Only keys strictly inside the window are used.
   */
  mid?: { at: number; v: DofPartial }[];
  /**
   * WP-P (additive): the generic weight-scaled wind-up layer (windup.ts). `false` = this move keeps its authored anticipation
   * unchanged; `coil` replaces the archetype's table pose; `gain` scales the strength; `noArcs` skips the minimum limb arc.
   */
  windup?: false | { coil?: DofPartial; gain?: number; noArcs?: boolean };
  /** WP-P (additive): follow-through knobs — extra overshoot gain and the dwell (fraction of the recovery the overshoot is held; default weight-derived). */
  commit?: number;
  /**
   * WP-B2 (additive): an AUTHORED pre-strike key script (the mole's burrow dive: dig-in f0-5, hidden tunnel pose, rise) that REPLACES the
   * generic anticipation / load / `pre` keys and the wind-up layer. Keys sit at move frames before the strike; `v` is a DOF partial (facing
   * +1, near striker) or a function of the solved strike pose. `A` is then only the pose the overshoot extrapolates away from (pass the last
   * script pose). The arrival at the strike key eases with `strikeEase` / `strikePow` (default `inout`).
   */
  script?: { f: number; v: DofPartial | ((B: DofVec) => DofPartial); ease?: Ease; pow?: number }[];
  strikeEase?: Ease;
  strikePow?: number;
  /** WP-B2 (additive): easing of the final settle (overshoot → rest); default `inout`. `out` = the pose drops back fast, then eases in. */
  settleEase?: Ease;
  settlePow?: number;
}

export interface ArchCtx {
  prof: AnimalProfile;
  body: MoveBody;
  air: boolean;
  chain: number;
  S: number;
  A: number;
  R: number;
  anim: Readonly<Record<string, number | string>>;
  /** Resolved striker role family from the data (`anim.limb`), with fall-backs for missing anatomy. */
  role: TipRole;
  /** The striking side relative to the camera: 'Near' | 'Far'. */
  side: 'Near' | 'Far';
  /** +1 when the main target is in front of the fighter, −1 when it is behind. */
  dir: 1 | -1;
  /** Displacement (m) of the main hitbox over its active window (sweeping boxes): a big negative dy = a downward chop. */
  sweepDx: number;
  sweepDy: number;
  /** Main target (fighter-local: x forward, y up) at the first active frame. */
  tx: number;
  ty: number;
  has(role: TipRole): boolean;
}

export type ArchFn = (c: ArchCtx) => ArchSpec;

export interface AnimalProfile {
  animal: AnimalId;
  /** DOF → joint channel links (facing +1 frame). */
  links: Partial<Record<DofName, readonly DofLink[]>>;
  tips: Partial<Record<TipRole, TipDef>>;
  /** Joint pairs swapped for facing −1 (both directions are implied). */
  mirror: readonly (readonly [string, string])[];
  /** Metres the hips drop when the animal collapses (knockdown). */
  hipDrop: number;
  /** Hip height above the feet (m); a crouch (`bodyUp < 0`) on the ground is turned into a root squash of `−bodyUp / hipHeight`. Default 0.9. */
  hipHeight?: number;
  /** Tilt (rad) of the whole body about the hurtbox centre while hanging from a ledge (nose up). */
  hangTilt: number;
  limits?: DofLimits;
  /** Per-animal replacements for generic archetypes (odd anatomies). */
  overrides?: Partial<Record<ArchetypeId, ArchFn>>;
  /** Extra DOF offsets added on top of the generic state poses (name = state key, see states.ts). WP-A3: may be a pure function of the state context (flap cycles, glide weights…). */
  states?: Partial<Record<string, StateExtra>>;
  /** WP-A3 (additive): replace the rig's own base pose written under a state (`null` = none; the rig's flight / gait would clash with the profile's DOFs). */
  stateBase?: Partial<Record<string, 'idle' | 'run' | 'jump' | null>>;
  /**
   * WP-A3 (additive): constant DOF overlay of the animal's neutral pose in ATTACK mode where the joints' rest transform is not it
   * (eagle: the wings rest at full span). Added to every key of every move (and to the solver's finished pose), so DOF values in
   * archetype specs are RELATIVE to it; `neutralAir` (default: `neutral`) is the same for aerials.
   */
  neutral?: DofPartial;
  neutralAir?: DofPartial;
  /** WP-P (additive): global gain of the generic wind-up layer for this animal (default 1). */
  windupGain?: number;
  /** WP-P (additive): per-animal replacement of the generic wind-up coil pose of an archetype (see windup.ts `COIL`). */
  coil?: Partial<Record<ArchetypeId, DofPartial>>;
  /** Free-form notes (shown in the demo). */
  note?: string;
}

// ── Compiled profile (bound to one rig instance) ───────────────────────────────

interface CLink {
  j: Joint;
  jm: Joint;
  ch: number;
  k: number;
}

export class CompiledProfile {
  readonly profile: AnimalProfile;
  readonly joints: ReadonlyMap<string, Joint>;
  private readonly links: CLink[][] = [];
  /** Joints with at least one link (the ones an `expand` can touch). */
  readonly touched: Joint[] = [];
  /** `jm` = the mirror joint (the tip joint when the fighter faces −1). */
  readonly tips = new Map<TipRole, { j: Joint; jm: Joint; off: THREE.Vector3 }>();

  constructor(profile: AnimalProfile, joints: ReadonlyMap<string, Joint>) {
    this.profile = profile;
    this.joints = joints;
    const mir = new Map<string, string>();
    for (const [a, b] of profile.mirror) {
      mir.set(a, b);
      mir.set(b, a);
    }
    const touched = new Set<Joint>();
    for (let i = 0; i < DOF_N; i++) this.links.push([]);
    for (const key of Object.keys(profile.links)) {
      const list = profile.links[key as DofName];
      if (list === undefined) continue;
      for (const l of list) {
        const j = joints.get(l.j);
        if (j === undefined) continue; // profile names a joint this rig does not have: ignored
        const jm = joints.get(mir.get(l.j) ?? l.j) ?? j;
        this.links[DOF[key as DofName]].push({ j, jm, ch: CH_INDEX[l.ch], k: l.k });
        touched.add(j);
        touched.add(jm);
      }
    }
    this.touched.push(...touched);
    for (const r of TIP_ROLES) {
      const t = profile.tips[r];
      if (t === undefined) continue;
      const j = joints.get(t.j);
      if (j === undefined) continue;
      this.tips.set(r, { j, jm: joints.get(mir.get(t.j) ?? t.j) ?? j, off: new THREE.Vector3(t.off[0], t.off[1], t.off[2]) });
    }
  }

  /** Does the profile drive this DOF at all on this rig? */
  drives(d: DofName): boolean {
    return this.links[DOF[d]].length > 0;
  }

  hasTip(r: TipRole): boolean {
    return this.tips.has(r);
  }

  /** ADD `v` (DOF values) to the joint targets. `facing` −1 applies the mirrored pose. */
  expand(v: DofVec, facing: 1 | -1, weight = 1): void {
    for (let i = 0; i < DOF_N; i++) {
      const val = v[i] * weight;
      if (val === 0) continue;
      const ls = this.links[i];
      for (let n = 0; n < ls.length; n++) {
        const l = ls[n];
        if (facing === 1) addCh(l.j, l.ch, l.k * val);
        else addCh(l.jm, l.ch, l.k * val * MIRROR_SIGN[l.ch]);
      }
    }
  }
}

function addCh(j: Joint, ch: number, d: number): void {
  switch (ch) {
    case 0:
      j.rx += d;
      break;
    case 1:
      j.ry += d;
      break;
    case 2:
      j.rz += d;
      break;
    case 3:
      j.px += d;
      break;
    case 4:
      j.py += d;
      break;
    case 5:
      j.pz += d;
      break;
    default:
      j.s += d;
  }
}

// ── Registry ───────────────────────────────────────────────────────────────────

const registry = new Map<AnimalId, AnimalProfile>();

/** Register a hand-written profile (animals/<animal>.ts do this through animals/index.ts). */
export function registerProfile(p: AnimalProfile): void {
  registry.set(p.animal, p);
}

export function getRegisteredProfile(animal: AnimalId): AnimalProfile | undefined {
  return registry.get(animal);
}
