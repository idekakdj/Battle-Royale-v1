/**
 * BrawlRig — one existing animal rig performing Champions League states and moves, side-on.
 *
 * Owns the ROOT transform (hierarchy `root → pivot → inner → yaw → rig.root`):
 *  - `root`   position (feet centre, z = 0), hitlag shake;
 *  - `pivot`  at the hurtbox centre: tumble / ledge-hang tilt / forward roll about the z axis (the view axis);
 *  - `inner`  at the feet: squash & stretch;
 *  - `yaw`    eased facing yaw ±(90° − 22°) (the camera sits on the +Z side, X to the right).
 *
 * Poses are written through the additive BaseRig hook (`brawlApply`): the DOF timeline of the current move
 * (build.ts, a pure function of moveFrame + subframe alpha) or the generic state pose (states.ts) is expanded through
 * the animal's profile and blended from the previously displayed pose with a short per-call blend.
 */

import * as THREE from 'three';
import type { AnimalId } from '../../../core/types';
import { AnimalFactory } from '../../../render/animals/AnimalFactory';
import type { BaseRig, Joint } from '../../../render/animals/Animator';
import { getMoveBody, getMoveset } from '../../data';
import type { BrawlFighterState, MoveBody } from '../../types';
import { STEP_NORMAL, STEP_STRIKE, entryBlendFrames, getBuilt, type BuiltMove } from './build';
import { DOF, newVec } from './dof';
import { CompiledProfile, TIP_ROLES, type AnimalProfile, type TipRole } from './profile';
import { getSolver } from './solver';
import { rigHiddenUnderground } from './underground';
import { newStatePose, poseState, type StateCtx, type StateKey, type StatePose } from './states';

/** Facing yaw magnitude: 90° minus the 22° turn toward the camera. */
export const FACE_YAW = ((90 - 22) * Math.PI) / 180;
const FPS = 60;
/** The yaw turns over about 4 frames. */
const TURN_RATE = (2 * FACE_YAW) / (4 / FPS);

const _v = new THREE.Vector3();

interface Dims {
  w: number;
  h: number;
  runSpeed: number;
}

const dimCache = new Map<AnimalId, Dims>();
function dimsOf(animal: AnimalId): Dims {
  let d = dimCache.get(animal);
  if (d === undefined) {
    const st = getMoveset(animal).stats;
    d = { w: st.width, h: st.height, runSpeed: st.runSpeed };
    dimCache.set(animal, d);
  }
  return d;
}

export class BrawlRig {
  /** Add this to the scene; position it with `update`. */
  readonly root = new THREE.Group();
  readonly rig: BaseRig;
  readonly animal: AnimalId;
  readonly profile: AnimalProfile;
  /** Hitlag shake scale for hit fighters (0 = the view shakes them itself). */
  shake = 1;

  private readonly cp: CompiledProfile;
  private readonly pivot = new THREE.Group();
  private readonly inner = new THREE.Group();
  private readonly yawG = new THREE.Group();
  private readonly dims: Dims;
  private readonly sp: StatePose = newStatePose();
  private readonly vec = newVec();
  private readonly ctx: StateCtx;

  private yaw = 0;
  private sqCur = 0;
  private angCur = 0;
  private liftCur = 0;
  private smoothInit = false;
  private yawInit = false;
  private tumble = 0;
  private flail = 0;
  private lastVy = 0;
  private facing: 1 | -1 = 1;
  private restart = 0;
  private lastAtk = '';
  private lastMoveFrame = 0;
  private mode: 'state' | 'atk' = 'state';
  private built: BuiltMove | null = null;
  private moveF = 0;
  private lastBody: MoveBody | null = null;
  private lastAir = false;
  private lastBuilt: BuiltMove | null = null;
  private stateKey: StateKey = 'idle';
  private hiddenUg = false;
  /** Debug / demo read-outs. */
  lastKey = '';
  strikeRole: TipRole | null = null;

  constructor(animal: AnimalId) {
    this.animal = animal;
    this.rig = AnimalFactory.createRig(animal);
    this.profile = getSolver(animal).profile;
    this.cp = new CompiledProfile(this.profile, this.rig.brawlJoints());
    this.dims = dimsOf(animal);
    this.ctx = {
      cur: null as unknown as BrawlFighterState,
      t: 0,
      total: 0,
      runK: 0,
      facing: 1,
      hipDrop: this.profile.hipDrop,
      hangTilt: this.profile.hangTilt,
      impactVy: 0,
      launchDir: 0,
      launchSpeed: 0,
      flail: 0,
      extra: undefined,
    };
    this.root.add(this.pivot);
    this.pivot.position.set(0, this.dims.h / 2, 0);
    this.pivot.add(this.inner);
    this.inner.position.set(0, -this.dims.h / 2, 0);
    this.inner.add(this.yawG);
    this.yawG.add(this.rig.root);
    this.root.name = `brawl-${animal}`;
  }

  // ── Per-frame update ───────────────────────────────────────────────────────

  /**
   * Pose + place the fighter for the display time `prev → cur` at `alpha` ∈ [0,1].
   * The pose evaluates at the continuous frame `cur.frame − (1 − alpha)`, so it is a pure function of the sim state
   * (identical at any refresh rate); `dtRender` only drives the short cross-fades and the ambient idle/gait clocks.
   */
  update(cur: BrawlFighterState, prev: BrawlFighterState | null, alpha: number, dtRender: number): void {
    const dt = dtRender < 0 ? 0 : dtRender > 0.1 ? 0.1 : dtRender;
    if (!cur.alive || cur.action === 'ko') {
      this.root.visible = false;
      this.hiddenUg = false;
      this.yawInit = false;
      return;
    }
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    // v1.6 burrow: the rig is not drawn while the fighter is underground (the view shows a dirt mound instead). The pose keeps
    // running underneath, so it is exactly where the timeline says the frame it surfaces. Stateless: a rollback cannot leave it hidden.
    this.hiddenUg = rigHiddenUnderground(cur, prev, a);
    this.root.visible = !this.hiddenUg;
    this.facing = cur.facing;

    // Position (interpolated; a teleport such as a respawn snaps).
    let px = cur.pos.x;
    let py = cur.pos.y;
    if (prev !== null && prev.alive) {
      const dx = cur.pos.x - prev.pos.x;
      const dy = cur.pos.y - prev.pos.y;
      if (dx * dx + dy * dy < 9) {
        px = prev.pos.x + dx * a;
        py = prev.pos.y + dy * a;
      }
    }

    // Eased facing yaw.
    const target = cur.facing * FACE_YAW;
    if (!this.yawInit) {
      this.yaw = target;
      this.yawInit = true;
    } else {
      const d = target - this.yaw;
      const k = 1 - Math.exp(-dt * 26);
      const stepMax = TURN_RATE * dt;
      let step = d * k;
      if (Math.abs(step) < Math.min(Math.abs(d), stepMax * 0.35)) step = Math.sign(d) * Math.min(Math.abs(d), stepMax * 0.35);
      if (Math.abs(step) > stepMax) step = Math.sign(step) * stepMax;
      this.yaw += step;
    }
    this.yawG.rotation.y = this.yaw;

    // Decide the pose source.
    this.chooseSource(cur, prev, a, dt);

    // Root-level channels (squash, tilt / roll about the hurtbox centre, lift), low-pass filtered so key switches never pop.
    const sp = this.sp;
    this.updateTumble(cur, dt);
    const angT = cur.facing * sp.tilt - cur.facing * sp.roll;
    if (!this.smoothInit) {
      this.sqCur = sp.squash;
      this.angCur = angT;
      this.liftCur = sp.lift;
      this.smoothInit = true;
    } else {
      const k = 1 - Math.exp(-dt * 38);
      this.sqCur += (sp.squash - this.sqCur) * k;
      this.angCur += (angT - this.angCur) * k;
      this.liftCur += (sp.lift - this.liftCur) * k;
    }
    this.pivot.rotation.z = this.angCur + this.tumble;
    const sq = this.sqCur;
    this.inner.scale.set(1 + 0.5 * sq, 1 - sq, 1 + 0.5 * sq);
    let sx = 0;
    if (this.shake > 0 && cur.hitlag > 0 && (cur.action === 'hitstun' || cur.action === 'tumble')) {
      sx = ((cur.hitlag & 1) === 1 ? 1 : -1) * 0.07 * this.shake * Math.min(1, cur.hitlag / 5);
    }
    this.root.position.set(px + sx, py + this.liftCur, 0);

    // Pose the joints.
    const speed = cur.grounded ? Math.abs(cur.vel.x) : 0;
    this.rig.brawlTick(dt, speed);
    const key = this.lastKey;
    const blendFrames = this.blendFramesFor();
    this.rig.brawlApply(this.drive, dt, key, blendFrames / FPS, this.capFor(dt));
    if (!cur.grounded) this.lastVy = cur.vel.y;
  }

  private readonly drive = (_joints: ReadonlyMap<string, Joint>): void => {
    if (this.mode === 'atk' && this.built !== null) {
      this.cp.expand(this.vec, this.facing);
      return;
    }
    const sp = this.sp;
    if (sp.base === 'idle') this.rig.brawlBase('idle');
    else if (sp.base === 'run') this.rig.brawlBase('run', sp.baseArg);
    else if (sp.base === 'jump') this.rig.brawlBase('jump', sp.baseArg);
    this.cp.expand(sp.dofs, this.facing);
  };

  private chooseSource(cur: BrawlFighterState, prev: BrawlFighterState | null, a: number, _dt: number): void {
    void prev;
    const sp = this.sp;
    if (cur.action === 'attack' && cur.moveId !== null) {
      const body: MoveBody = getMoveBody(this.animal, cur.moveId, cur.moveAir, cur.moveChain);
      if (body !== this.lastBody || cur.moveAir !== this.lastAir) {
        this.lastBody = body;
        this.lastAir = cur.moveAir;
        this.lastBuilt = getBuilt(this.animal, body, cur.moveAir, cur.moveChain);
      }
      const built = this.lastBuilt as BuiltMove;
      const id = `${cur.moveId}|${cur.moveAir ? 1 : 0}|${cur.moveChain}`;
      if (id === this.lastAtk && cur.moveFrame < this.lastMoveFrame - 0.5) this.restart++;
      this.lastAtk = id;
      this.lastMoveFrame = cur.moveFrame;
      const f = cur.hitlag > 0 ? cur.moveFrame : cur.moveFrame - (1 - a);
      this.moveF = f < 0 ? 0 : f;
      this.built = built;
      this.mode = 'atk';
      this.strikeRole = built.tip;
      this.lastKey = `atk|${id}|${this.restart}`;
      built.timeline.evalAt(this.moveF, this.vec);
      sp.squash = this.vec[DOF.rootSquash];
      sp.tilt = 0;
      sp.roll = 0;
      sp.lift = 0;
      sp.base = null;
      return;
    }
    this.lastAtk = '';
    this.mode = 'state';
    this.built = null;
    this.strikeRole = null;
    const key = this.stateOf(cur);
    this.stateKey = key;
    this.lastKey = key;
    const ctx = this.ctx;
    ctx.cur = cur;
    ctx.facing = cur.facing;
    ctx.t = cur.hitlag > 0 ? cur.actionFrame : Math.max(0, cur.actionFrame - (1 - a));
    ctx.total = cur.actionFrames;
    ctx.runK = Math.abs(cur.vel.x) / this.dims.runSpeed;
    ctx.impactVy = this.lastVy;
    const ang = cur.lastLaunch !== null ? (cur.lastLaunch.angle * Math.PI) / 180 : Math.PI;
    const c = Math.cos(ang) * cur.facing;
    ctx.launchDir = c > 0.2 ? 1 : c < -0.2 ? -1 : 0;
    ctx.launchSpeed = cur.lastLaunch !== null ? cur.lastLaunch.speed : 0;
    ctx.flail = this.flail;
    const ex = this.profile.states?.[key];
    ctx.extra = typeof ex === 'function' ? ex(ctx) : ex;
    poseState(key, ctx, sp);
    const sb = this.profile.stateBase?.[key];
    if (sb !== undefined) sp.base = sb;
  }

  private stateOf(cur: BrawlFighterState): StateKey {
    switch (cur.action) {
      case 'walk':
      case 'run':
        return 'run';
      case 'jumpSquat':
      case 'rise':
      case 'fall':
      case 'fastFall':
      case 'landing':
      case 'crouch':
      case 'dodgeSpot':
      case 'dodgeRoll':
      case 'dodgeAir':
      case 'hitstun':
      case 'tumble':
      case 'knockdown':
      case 'getup':
      case 'ledgeHang':
      case 'ledgeClimb':
      case 'respawn':
        return cur.action;
      default:
        return 'idle';
    }
  }

  private updateTumble(cur: BrawlFighterState, dt: number): void {
    if (cur.action === 'tumble') {
      if (cur.hitlag <= 0) {
        const sp = cur.lastLaunch !== null ? cur.lastLaunch.speed : 20;
        const dir = cur.lastLaunch !== null && Math.cos((cur.lastLaunch.angle * Math.PI) / 180) < 0 ? 1 : -1;
        const omega = Math.min(22, Math.max(5, sp * 0.4));
        this.tumble += dir * omega * dt;
        this.flail += dt * FPS;
      }
    } else if (this.tumble !== 0) {
      // Settle to the nearest whole turn, then to zero (the body is upright again).
      const turns = Math.round(this.tumble / (2 * Math.PI)) * 2 * Math.PI;
      this.tumble += (turns - this.tumble) * (1 - Math.exp(-dt * 16));
      if (Math.abs(turns - this.tumble) < 0.02) this.tumble = 0;
    }
  }

  private blendFramesFor(): number {
    if (this.mode === 'atk' && this.built !== null) return entryBlendFrames(this.built.strikeFrame);
    switch (this.stateKey) {
      case 'hitstun':
      case 'tumble':
        return 1.5;
      case 'landing':
      case 'dodgeSpot':
      case 'dodgeRoll':
      case 'dodgeAir':
      case 'jumpSquat':
        return 2;
      default:
        return 3;
    }
  }

  /** Per-call rotation cap (the smoothness safety net, see `Joint.applyBrawl`). */
  private capFor(dt: number): number {
    const k = Math.max(0.1, dt * FPS);
    if (this.mode === 'atk' && this.built !== null) {
      const b = this.built;
      const strike = this.moveF >= b.strikeFrame - 2.5 && this.moveF <= b.activeEnd - 1 + 1e-6;
      return (strike ? STEP_STRIKE - 0.02 : STEP_NORMAL - 0.02) * k;
    }
    if (this.stateKey === 'hitstun' || this.stateKey === 'tumble') return 1.1 * k;
    if (this.stateKey === 'dodgeAir' || this.stateKey === 'dodgeRoll') return 0.85 * k;
    return (STEP_NORMAL - 0.02) * k;
  }

  // ── Tip queries (VFX anchors, tests) ───────────────────────────────────────

  private resolveRole(role: string): TipRole | null {
    if (role === 'strike') return this.strikeRole;
    if ((TIP_ROLES as readonly string[]).includes(role)) return role as TipRole;
    switch (role) {
      case 'paw':
      case 'fore':
      case 'claw':
        return 'foreNear';
      case 'hind':
        return 'hindNear';
      case 'wing':
        return 'wingNear';
      default:
        return null;
    }
  }

  /** Tip position in rig-local metres (x lateral, y up, z forward; squash/tilt removed). Null when the role has no tip. */
  tipLocal(role: string, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 | null {
    const r = this.resolveRole(role);
    if (r === null) return null;
    const t = this.cp.tips.get(r);
    if (t === undefined) return null;
    const node = this.facing === 1 ? t.j.node : t.jm.node;
    this.root.updateMatrixWorld(true);
    _v.set(this.facing === 1 ? t.off.x : -t.off.x, t.off.y, t.off.z).applyMatrix4(node.matrixWorld);
    this.rig.root.worldToLocal(_v);
    // The inner group squashes the rig about the feet: report the tip where it is SEEN (fighter space).
    return out.set(_v.x * (1 + 0.5 * this.sqCur), _v.y * (1 - this.sqCur), _v.z * (1 + 0.5 * this.sqCur));
  }

  /** Tip position in WORLD space (VFX anchors). Null when the role has no tip. */
  tipWorld(role: string): THREE.Vector3 | null {
    const r = this.resolveRole(role);
    if (r === null) return null;
    const t = this.cp.tips.get(r);
    if (t === undefined) return null;
    const node = this.facing === 1 ? t.j.node : t.jm.node;
    this.root.updateMatrixWorld(true);
    return new THREE.Vector3(this.facing === 1 ? t.off.x : -t.off.x, t.off.y, t.off.z).applyMatrix4(node.matrixWorld);
  }

  /** Fighter-local (x forward, y up) tip coordinates in the sim's hitbox space — `tipLocal` mapped (z → x). */
  tipFighterLocal(role: string): { x: number; y: number } | null {
    const p = this.tipLocal(role);
    return p === null ? null : { x: p.z, y: p.y };
  }

  /** True while the rig is hidden because the fighter is underground (v1.6 burrow): no body, no contact shadow. */
  get hiddenUnderground(): boolean {
    return this.hiddenUg;
  }

  /** Current (eased) facing yaw in radians — demo / tests. */
  get yawAngle(): number {
    return this.yaw;
  }

  /** Current (smoothed) root squash — demo / tests. */
  get squashNow(): number {
    return this.sqCur;
  }

  /** The built move currently being performed (null outside attacks) — demo / tests. */
  get currentBuilt(): BuiltMove | null {
    return this.mode === 'atk' ? this.built : null;
  }

  dispose(): void {
    this.rig.dispose();
    this.root.removeFromParent();
  }
}
