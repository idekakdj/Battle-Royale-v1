/**
 * First-person ULTIMATE CAMERA DIRECTOR (v1.3 Phase-3c).
 *
 * While the local player's ultimate runs in first person, the per-animal
 * directive module (`fp/ult/<animal>.ts`, registry in `fp/ult/index.ts`) writes
 * a handful of VIEW CHANNELS each frame into a {@link UltView}; this class
 * smooths them, adds the impulse springs (kicks / FOV kicks / shake / eye
 * slide / vignette) and publishes the result as a {@link UltCamOut} that the
 * `CameraRig` composes into the first-person camera. It never touches body roll
 * or spin: everything here is a deliberate, view-only offset on top of the
 * player's own yaw/pitch, so it can never inherit a rig's rotation.
 *
 * Pure maths (no three.js / DOM) — unit-tested in tests/render/ultCam.test.ts.
 *
 * ── Writing a directive ──────────────────────────────────────────────────────
 *   export const lionUlt: UltDirector = {
 *     view(c, v) {                        // every frame while casting
 *       v.eyeY = -0.3 * sm(c.pt, 0, 0.3); // sink with the crouch (metres)
 *       if (c.victim) {                   // soft look-at on the victim
 *         v.lookW = 0.6;
 *         v.lookPitch = pitchTo(c.eye, c.victim.x, c.victim.y + 0.9, c.victim.z);
 *         v.yawTo = yawToPoint(c.eye, c.victim.x, c.victim.z); // persistent, eased
 *         v.yawRate = 5;
 *         v.mouseYaw = 0.6;               // the mouse still half works
 *       }
 *     },
 *     stage(c, stage) { if (stage === 2) c.fx.kick(-0.09); }, // snapshot ultStage changed
 *   };
 *
 * Channels (all TARGETS; the director eases them at `v.smooth` 1/s, default 16,
 * and back to neutral at {@link RETURN_RATE} once the ultimate ends):
 *   pitch/roll      additive view angle (rad; +pitch = up, +roll = left side down)
 *   lookW/lookPitch blend the final pitch toward an ABSOLUTE look-at pitch
 *   yawTo/yawRate   persistent yaw ease toward an absolute yaw (the player's own
 *                   yaw is moved, like the lock-on camera), NaN = leave yaw alone
 *   mouseYaw/Pitch  scale on the player's mouse (1 = free, 0 = locked)
 *   eyeY/eyeF       eye offset (m): up, and forward along the view yaw
 *   fovPct          vertical FOV multiplier offset (0.1 = +10 %)
 *   follow          multiplier on the profile's head-follow (0 = rigid eye)
 *   shake/vignette  continuous screen shake (rad of noise) / edge darkening 0..1
 * Impulses live on `c.fx` (kick, fov, shake, vignette, flash, slide) and decay
 * by themselves.
 */

import type { AnimalId, FighterState } from '../../../core/types';
import { angleDiff, clampNum } from './math';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** Rate (1/s) at which every channel relaxes to neutral once the ultimate ends (~0.35 s to settle). */
export const RETURN_RATE = 7;
/** Same hard pitch limit as the CameraRig applies with the director's offsets. */
const ULT_VIEW_MAX = 1.5;

// ── tiny maths helpers for directives ─────────────────────────────────────────

/** 0..1 linear ramp of `x` over [a, b]. */
export function ramp(x: number, a: number, b: number): number {
  if (b <= a) return x >= b ? 1 : 0;
  const t = (x - a) / (b - a);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smoothstep ramp of `x` over [a, b]. */
export function sm(x: number, a: number, b: number): number {
  const t = ramp(x, a, b);
  return t * t * (3 - 2 * t);
}

/** 0..1..0 bump: rises over [a, b], falls over [b, c]. */
export function bump(x: number, a: number, b: number, c: number): number {
  return sm(x, a, b) * (1 - sm(x, b, c));
}

/** Look-pitch (rad, + = up) from an eye point to a target point. */
export function pitchTo(eye: V3, tx: number, ty: number, tz: number): number {
  const h = Math.hypot(tx - eye.x, tz - eye.z);
  return Math.atan2(ty - eye.y, h < 1e-6 ? 1e-6 : h);
}

/** Look-yaw (rad, game convention: forward = (sin yaw, cos yaw)) from an eye point to a target point. */
export function yawToPoint(eye: V3, tx: number, tz: number): number {
  return Math.atan2(tx - eye.x, tz - eye.z);
}

/** Pitch clamp used by directives that look at points very close to / far below the eye. */
export function clampPitch(p: number, lo: number, hi: number): number {
  return clampNum(p, lo, hi);
}

// ── channels ──────────────────────────────────────────────────────────────────

/** The per-frame view TARGETS a directive writes (reset to neutral before every `view` call). */
export class UltView {
  pitch = 0;
  roll = 0;
  lookW = 0;
  lookPitch = 0;
  yawTo = Number.NaN;
  yawRate = 8;
  mouseYaw = 1;
  mousePitch = 1;
  eyeY = 0;
  eyeF = 0;
  fovPct = 0;
  follow = 1;
  shake = 0;
  vignette = 0;
  /** Follower rate (1/s) used to ease the channels toward these targets. */
  smooth = 16;

  reset(): void {
    this.pitch = 0;
    this.roll = 0;
    this.lookW = 0;
    this.yawTo = Number.NaN;
    this.yawRate = 8;
    this.mouseYaw = 1;
    this.mousePitch = 1;
    this.eyeY = 0;
    this.eyeF = 0;
    this.fovPct = 0;
    this.follow = 1;
    this.shake = 0;
    this.vignette = 0;
    this.smooth = 16;
  }
}

/** What the CameraRig / overlay read each frame (neutral values when nothing is happening). */
export class UltCamOut {
  /** True while any channel is non-neutral (cheap early-out for the camera). */
  active = false;
  /** Blend-able additive pitch (rad). */
  pitch = 0;
  lookW = 0;
  lookPitch = 0;
  /** Additive pitch applied AFTER the look-at blend (kicks + shake). */
  kick = 0;
  /** Total view roll (rad): module roll + kick roll + shake. */
  roll = 0;
  /** View-only yaw offset (rad, shake / flick) — the player's yaw is untouched. */
  yawOff = 0;
  eyeY = 0;
  eyeF = 0;
  slideX = 0;
  slideY = 0;
  slideZ = 0;
  fovPct = 0;
  follow = 1;
  mouseYaw = 1;
  mousePitch = 1;
  vignette = 0;
  flash = 0;

  reset(): void {
    this.active = false;
    this.pitch = 0;
    this.lookW = 0;
    this.lookPitch = 0;
    this.kick = 0;
    this.roll = 0;
    this.yawOff = 0;
    this.eyeY = 0;
    this.eyeF = 0;
    this.slideX = 0;
    this.slideY = 0;
    this.slideZ = 0;
    this.fovPct = 0;
    this.follow = 1;
    this.mouseYaw = 1;
    this.mousePitch = 1;
    this.vignette = 0;
    this.flash = 0;
  }
}

/** Impulse API handed to directives (all effects decay on their own). */
export interface UltFxApi {
  /** View kick: PEAK pitch (rad, negative = down) and optional roll peak; springs back by itself. */
  kick(pitch: number, roll?: number): void;
  /** FOV kick (fraction, 0.06 = +6 %), decays in ~0.2 s. */
  fov(pct: number): void;
  /** Screen shake STRENGTH (0..1 ≈ 4° of pitch noise at 1), decays in ~0.25 s. */
  shake(amp: number): void;
  /** Edge-darkening flick 0..1, decays in ~0.1 s. */
  vignette(a: number): void;
  /** Full-screen pulse 0..1 (overlay), decays in ~0.1 s. */
  flash(a: number): void;
  /** Eye offset (world m) that slides back to zero in ~0.1 s (a blink without a position pop). */
  slide(dx: number, dy: number, dz: number): void;
}

export type UltPhase = 'windup' | 'active' | 'recovery';

/** Everything a directive may read. One object is reused every frame — do not keep references. */
export interface UltCtx {
  animal: AnimalId;
  dt: number;
  state: FighterState;
  phase: UltPhase;
  /** `state.ultStage ?? 0`. */
  stage: number;
  /** Seconds since the cast began (director clock; survives phase restarts). */
  t: number;
  /** Seconds since the current PHASE began (director clock — independent of how `actionT` is restarted). */
  pt: number;
  /** Seconds since the last stage change or phase change. */
  st: number;
  /** Seconds since the last `blink` event (large when none). */
  bt: number;
  /** `state.actionDur` of the current phase (may be 0). */
  pd: number;
  /** World eye position (the camera's position last frame). */
  eye: V3;
  /** The un-offset eye: the rig root + the profile's forward eye offset along the view yaw (no director offsets applied). */
  eye0: V3;
  /** The view's yaw / pitch (the player's own, after the mouse). */
  yaw: number;
  pitch: number;
  /** Locked victim's position (feet), or null. */
  victim: V3 | null;
  /** `pos` of the latest `ultimateStage` event (committed point / landing / reticle), or null. */
  stagePos: V3 | null;
  /** The `ultimateTarget` event's `to` (path end / zone centre / victim), or null. */
  aim: V3 | null;
  /** Horizontal speed (m/s) and vertical velocity. */
  speed: number;
  vy: number;
  /** Sim yaw rate (rad/s, low-passed; + = turning left). */
  yawRate: number;
  /** Per-cast scratch (cleared when a cast starts). */
  mem: Record<string, number>;
  fx: UltFxApi;
  /** True the first time `cond` holds during this cast for `key` (one-shot triggers). */
  once(key: string, cond: boolean): boolean;
}

export interface UltDirector {
  /** Called every frame while the ultimate runs; write targets into `v` (already reset to neutral). */
  view(c: UltCtx, v: UltView): void;
  /** The snapshot's `ultStage` (or phase) changed. */
  stage?(c: UltCtx, stage: number): void;
  /** A `blink` event for the local player (the director already slides the eye; this is for re-aim / vignette). */
  blink?(c: UltCtx, from: V3, to: V3): void;
  /** The cast began. */
  start?(c: UltCtx): void;
}

/**
 * Shared read-only clock of the local player's running ultimate, for FP POSE hooks (`fp/<animal>.ts`
 * `pose(c)`): `stage` / `phase` mirror the snapshot, `st` = seconds since the last stage/phase change,
 * `pt` = seconds since the phase began, `t` = seconds since the cast began. Updated by {@link UltCamera}.
 */
export const ultClock = { casting: false, stage: 0, phase: 'windup' as UltPhase, st: 0, pt: 0, t: 0, view: 0, slide: 0 };

/** Per-frame inputs the host supplies (reused object). */
export interface UltEnv {
  /** The view's yaw (rad) and pitch (rad, + = up). */
  yaw: number;
  pitch: number;
  /** World eye (last frame's camera position). */
  eye: V3;
  /** The profile's forward eye offset (m) — for the un-offset eye `eye0`. */
  eyeForward: number;
  /** Position (feet) of fighter `id`, or null. */
  victim(id: number): V3 | null;
  /** Write the player's yaw (persistent). */
  setYaw(yaw: number): void;
}

// ── springs ───────────────────────────────────────────────────────────────────

/** Angular noise (rad) of `fx.shake(1)`. */
export const SHAKE_RAD = 0.07;
const KICK_W = 15; // critically-damped rate (peak at 1/W s)
const E = Math.E;

/** Critically damped spring; `impulse(peak)` makes the displacement peak at exactly `peak`. */
export class KickSpring {
  x = 0;
  v = 0;

  impulse(peak: number): void {
    this.v = clampNum(this.v + peak * KICK_W * E, -12, 12);
  }

  step(dt: number): void {
    const e = Math.exp(-KICK_W * dt);
    const c2 = this.v + KICK_W * this.x;
    const nx = e * (this.x + c2 * dt);
    const nv = e * (this.v - KICK_W * c2 * dt);
    this.x = clampNum(nx, -1.2, 1.2);
    this.v = nv;
    if (Math.abs(this.x) < 1e-5 && Math.abs(this.v) < 1e-4) {
      this.x = 0;
      this.v = 0;
    }
  }
}

const NEUTRAL_EPS = 1e-4;

function follow(cur: number, target: number, k: number): number {
  return cur + (target - cur) * k;
}

/**
 * The director. One instance per match (the local player's rig). Feed it events
 * (`onTarget` / `onStage` / `onBlink`, local player only) and call `update` once
 * per render frame before the CameraRig; read `out`.
 */
export class UltCamera {
  readonly out: UltCamOut;

  private readonly tgt = new UltView();
  private readonly cur = new UltView();
  private dir: UltDirector | null = null;
  private readonly getDirector: (animal: AnimalId) => UltDirector | null;

  private casting = false;
  private animal: AnimalId = 'lion';
  private phase: UltPhase = 'windup';
  private stage = 0;
  private lastStage = -1;
  private lastPhase: UltPhase | '' = '';
  private t = 0;
  private pt = 0;
  private st = 0;
  private bt = 99;
  private clock = 0;
  private lastSimYaw = 0;
  private yawRate = 0;
  private yawInit = false;
  private mem: Record<string, number> = {};

  private readonly stagePos: V3 = { x: 0, y: 0, z: 0 };
  private hasStagePos = false;
  private readonly aim: V3 = { x: 0, y: 0, z: 0 };
  private hasAim = false;
  private readonly victimPos: V3 = { x: 0, y: 0, z: 0 };

  private readonly kp = new KickSpring();
  private readonly kr = new KickSpring();
  private fovK = 0;
  private shakeK = 0;
  private vigK = 0;
  private flashK = 0;
  private slideX = 0;
  private slideY = 0;
  private slideZ = 0;
  private pendingBlink: { from: V3; to: V3 } | null = null;
  /** Stage beats from events not yet delivered to the directive, and the (phase, stage) beats already delivered this cast. */
  private readonly evQ: number[] = [];
  private fired = new Set<string>();

  private readonly ctx: UltCtx;
  private readonly fxApi: UltFxApi;

  /** `out` may be supplied (the CameraRig's own {@link UltCamOut}) so no copy is needed per frame. */
  constructor(getDirector: (animal: AnimalId) => UltDirector | null, out: UltCamOut = new UltCamOut()) {
    this.getDirector = getDirector;
    this.out = out;
    this.fxApi = {
      kick: (pitch, roll = 0) => {
        if (pitch !== 0) this.kp.impulse(pitch);
        if (roll !== 0) this.kr.impulse(roll);
      },
      fov: (pct) => {
        this.fovK = Math.max(this.fovK, pct);
      },
      shake: (amp) => {
        this.shakeK = Math.max(this.shakeK, amp);
      },
      vignette: (a) => {
        this.vigK = Math.max(this.vigK, a);
      },
      flash: (a) => {
        this.flashK = Math.max(this.flashK, a);
      },
      slide: (dx, dy, dz) => {
        this.slideX += dx;
        this.slideY += dy;
        this.slideZ += dz;
        const l = Math.hypot(this.slideX, this.slideY, this.slideZ);
        if (l > 6) {
          const k = 6 / l;
          this.slideX *= k;
          this.slideY *= k;
          this.slideZ *= k;
        }
      },
    };
    const mem = (): Record<string, number> => this.mem;
    this.ctx = {
      animal: 'lion',
      dt: 0,
      state: undefined as unknown as FighterState,
      phase: 'windup',
      stage: 0,
      t: 0,
      pt: 0,
      st: 0,
      bt: 99,
      pd: 0,
      eye: { x: 0, y: 0, z: 0 },
      eye0: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      victim: null,
      stagePos: null,
      aim: null,
      speed: 0,
      vy: 0,
      yawRate: 0,
      mem: this.mem,
      fx: this.fxApi,
      once: (key, cond) => {
        const m = mem();
        if (!cond || m[key] === 1) return false;
        m[key] = 1;
        return true;
      },
    };
  }

  /** True while the local player's ultimate is being directed. */
  get isCasting(): boolean {
    return this.casting;
  }

  /** `ultimateTarget` for the local player: remember the path end / zone centre. */
  onTarget(to: V3): void {
    this.aim.x = to.x;
    this.aim.y = to.y;
    this.aim.z = to.z;
    this.hasAim = true;
    this.hasStagePos = false; // a new cast: forget the previous cast's beat point
  }

  /**
   * `ultimateStage` for the local player: remember the beat's point (committed point, landing …) and queue the beat so the
   * directive's `stage` hook also fires for beats that exist only as events (the panther's execute pulse, stage 7).
   */
  onStage(stage: number, pos: V3): void {
    if (this.evQ.length < 16) this.evQ.push(stage);
    this.stagePos.x = pos.x;
    this.stagePos.y = pos.y;
    this.stagePos.z = pos.z;
    this.hasStagePos = true;
  }

  /** `blink` for the local player: the eye slides from the old spot instead of popping. */
  onBlink(from: V3, to: V3): void {
    this.fxApi.slide(from.x - to.x, from.y - to.y, from.z - to.z);
    this.bt = 0;
    this.pendingBlink = { from: { ...from }, to: { ...to } };
  }

  /** Forget everything (match restart / mode switch). */
  reset(): void {
    this.casting = false;
    this.dir = null;
    this.out.reset();
    this.cur.reset();
    this.tgt.reset();
    this.kp.x = this.kp.v = this.kr.x = this.kr.v = 0;
    this.fovK = this.shakeK = this.vigK = this.flashK = 0;
    this.slideX = this.slideY = this.slideZ = 0;
    this.pendingBlink = null;
  }

  /**
   * Advance one render frame. `st` = the local player's snapshot state while
   * first person is active and the player is alive, else null (the view then
   * relaxes to neutral at {@link RETURN_RATE}).
   */
  update(dt: number, st: FighterState | null, env: UltEnv): void {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    this.clock += dt;
    this.bt += dt;

    const casting = st !== null && st.alive && (st.ultPhase !== undefined || st.action === 'ultimate');
    if (casting && !this.casting) this.startCast(st as FighterState, env);
    else if (!casting && this.casting) this.endCast();

    const tgt = this.tgt;
    tgt.reset();

    if (this.casting && st !== null) {
      this.t += dt;
      this.pt += dt;
      this.st += dt;
      const phase: UltPhase = st.ultPhase ?? 'active';
      const stage = st.ultStage ?? 0;
      this.phase = phase;
      this.stage = stage;
      // Sim yaw rate (low-passed) for turn-lean directives.
      if (!this.yawInit) {
        this.lastSimYaw = st.yaw;
        this.yawInit = true;
      }
      const yr = angleDiff(this.lastSimYaw, st.yaw) / dt;
      this.lastSimYaw = st.yaw;
      this.yawRate = follow(this.yawRate, clampNum(yr, -12, 12), 1 - Math.exp(-dt / 0.1));

      const c = this.fillCtx(dt, st, env);
      if (phase !== this.lastPhase) {
        this.lastPhase = phase;
        this.pt = 0;
        this.st = 0;
        this.lastStage = stage;
        c.pt = 0;
        c.st = 0;
        c.phase = phase;
        this.deliver(c, stage);
      } else if (stage !== this.lastStage) {
        this.lastStage = stage;
        this.st = 0;
        c.st = 0;
        this.deliver(c, stage);
      }
      // Beats that only exist as events (never visible in a snapshot) still reach the directive.
      for (let i = 0; i < this.evQ.length; i++) this.deliver(c, this.evQ[i]);
      this.evQ.length = 0;
      if (this.pendingBlink !== null) {
        const b = this.pendingBlink;
        this.pendingBlink = null;
        c.bt = 0;
        this.dir?.blink?.(c, b.from, b.to);
      }
      if (this.dir !== null) this.dir.view(c, tgt);

      // Persistent yaw ease (the player's yaw is moved, like the lock-on camera).
      if (!Number.isNaN(tgt.yawTo) && tgt.yawRate > 0) {
        env.setYaw(env.yaw + angleDiff(env.yaw, tgt.yawTo) * (1 - Math.exp(-tgt.yawRate * dt)));
      }
    } else {
      this.pendingBlink = null;
      this.evQ.length = 0;
    }

    ultClock.casting = this.casting;
    ultClock.stage = this.stage;
    ultClock.phase = this.phase;
    ultClock.st = this.st;
    ultClock.pt = this.pt;
    ultClock.t = this.t;
    this.integrate(dt);
    // The camera's effective pitch (mouse look + the director's offsets, as CameraRig composes it) so viewmodels that must stay
    // glued to the screen during the ultimate (`ultViewLock`) can follow it 1:1. View kick / shake noise are left out.
    const o = this.out;
    let vp = clampNum(env.pitch, -ULT_VIEW_MAX, ULT_VIEW_MAX) + o.pitch;
    if (o.lookW > 0) vp += (o.lookPitch - vp) * o.lookW;
    ultClock.view = clampNum(vp + o.kick, -ULT_VIEW_MAX, ULT_VIEW_MAX);
    // How far (m) the director has slid the eye away from the body (blink slides): while large the own body is seen from outside.
    ultClock.slide = Math.hypot(this.slideX, this.slideY, this.slideZ);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private startCast(st: FighterState, env: UltEnv): void {
    this.casting = true;
    this.animal = st.animal;
    this.dir = this.getDirector(st.animal);
    this.t = 0;
    this.pt = 0;
    this.st = 0;
    this.lastPhase = '';
    this.lastStage = -1;
    this.yawInit = false;
    this.yawRate = 0;
    this.mem = {};
    this.ctx.mem = this.mem;
    this.fired = new Set<string>();
    // (The aim / stage points arrived with THIS cast's events, which fire before the snapshot shows the phase.)
    const c = this.fillCtx(0, st, env);
    this.dir?.start?.(c);
  }

  /** Deliver a stage beat to the directive once per (phase, stage) per cast. */
  private deliver(c: UltCtx, stage: number): void {
    const key = c.phase + stage;
    if (this.fired.has(key)) return;
    this.fired.add(key);
    this.dir?.stage?.(c, stage);
  }

  private endCast(): void {
    this.casting = false;
    this.lastPhase = '';
    this.lastStage = -1;
  }

  private fillCtx(dt: number, st: FighterState, env: UltEnv): UltCtx {
    const c = this.ctx;
    c.animal = this.animal;
    c.dt = dt;
    c.state = st;
    c.phase = this.phase;
    c.stage = this.stage;
    c.t = this.t;
    c.pt = this.pt;
    c.st = this.st;
    c.bt = this.bt;
    c.pd = st.actionDur;
    c.eye.x = env.eye.x;
    c.eye.y = env.eye.y;
    c.eye.z = env.eye.z;
    c.eye0.x = st.pos.x + Math.sin(env.yaw) * env.eyeForward;
    c.eye0.y = st.pos.y;
    c.eye0.z = st.pos.z + Math.cos(env.yaw) * env.eyeForward;
    c.yaw = env.yaw;
    c.pitch = env.pitch;
    const id = st.ultTargetId ?? -1;
    const v = id >= 0 ? env.victim(id) : null;
    if (v !== null) {
      this.victimPos.x = v.x;
      this.victimPos.y = v.y;
      this.victimPos.z = v.z;
      c.victim = this.victimPos;
    } else {
      c.victim = null;
    }
    c.stagePos = this.hasStagePos ? this.stagePos : null;
    c.aim = this.hasAim ? this.aim : null;
    c.speed = Math.hypot(st.vel.x, st.vel.z);
    c.vy = st.vel.y;
    c.yawRate = this.yawRate;
    return c;
  }

  /** Ease the channels toward the targets, run the springs, publish `out`. */
  private integrate(dt: number): void {
    const tgt = this.tgt;
    const cur = this.cur;
    const o = this.out;
    const rate = this.casting ? tgt.smooth : RETURN_RATE;
    const k = 1 - Math.exp(-rate * dt);
    const kFast = 1 - Math.exp(-Math.max(rate, 12) * dt);

    cur.pitch = follow(cur.pitch, tgt.pitch, k);
    cur.roll = follow(cur.roll, tgt.roll, k);
    cur.lookW = follow(cur.lookW, tgt.lookW, k);
    cur.lookPitch = cur.lookW > 0.02 ? follow(cur.lookPitch, tgt.lookPitch, kFast) : tgt.lookPitch;
    cur.mouseYaw = follow(cur.mouseYaw, tgt.mouseYaw, kFast);
    cur.mousePitch = follow(cur.mousePitch, tgt.mousePitch, kFast);
    cur.eyeY = follow(cur.eyeY, tgt.eyeY, k);
    cur.eyeF = follow(cur.eyeF, tgt.eyeF, k);
    cur.fovPct = follow(cur.fovPct, tgt.fovPct, k);
    cur.follow = follow(cur.follow, tgt.follow, kFast);
    cur.shake = follow(cur.shake, tgt.shake, kFast);
    cur.vignette = follow(cur.vignette, tgt.vignette, k);

    this.kp.step(dt);
    this.kr.step(dt);
    this.fovK *= Math.exp(-dt / 0.2);
    if (this.fovK < 1e-4) this.fovK = 0;
    this.shakeK *= Math.exp(-dt / 0.25);
    if (this.shakeK < 1e-4) this.shakeK = 0;
    this.vigK *= Math.exp(-dt / 0.1);
    if (this.vigK < 1e-3) this.vigK = 0;
    this.flashK *= Math.exp(-dt / 0.1);
    if (this.flashK < 1e-3) this.flashK = 0;
    const ks = Math.exp(-dt / 0.055);
    this.slideX *= ks;
    this.slideY *= ks;
    this.slideZ *= ks;
    if (Math.abs(this.slideX) + Math.abs(this.slideY) + Math.abs(this.slideZ) < 1e-3) this.slideX = this.slideY = this.slideZ = 0;

    // Shake noise (view-only): a sum of incommensurate sines.
    const amp = this.shakeK * SHAKE_RAD + cur.shake;
    let np = 0;
    let nr = 0;
    let ny = 0;
    if (amp > 1e-4) {
      const t = this.clock;
      np = (Math.sin(t * 61.3) + 0.5 * Math.sin(t * 97.1 + 1.3)) * amp * 0.66;
      nr = (Math.sin(t * 53.7 + 3.1) + 0.5 * Math.sin(t * 83.9 + 0.4)) * amp * 0.5;
      ny = (Math.sin(t * 47.9 + 2.2) + 0.5 * Math.sin(t * 79.3 + 4.9)) * amp * 0.5;
    }

    o.pitch = cur.pitch;
    o.lookW = clampNum(cur.lookW, 0, 1);
    o.lookPitch = cur.lookPitch;
    o.kick = clampNum(this.kp.x + np, -1.2, 1.2);
    o.roll = clampNum(cur.roll + this.kr.x + nr, -0.6, 0.6);
    o.yawOff = ny;
    o.eyeY = cur.eyeY;
    o.eyeF = cur.eyeF;
    o.slideX = this.slideX;
    o.slideY = this.slideY;
    o.slideZ = this.slideZ;
    o.fovPct = cur.fovPct + this.fovK;
    o.follow = clampNum(cur.follow, 0, 1);
    o.mouseYaw = clampNum(cur.mouseYaw, 0, 1);
    o.mousePitch = clampNum(cur.mousePitch, 0, 1);
    o.vignette = clampNum(Math.max(cur.vignette, this.vigK), 0, 1);
    o.flash = clampNum(this.flashK, 0, 1);
    o.active =
      this.casting ||
      Math.abs(o.pitch) > NEUTRAL_EPS ||
      o.lookW > 0.002 ||
      Math.abs(o.kick) > NEUTRAL_EPS ||
      Math.abs(o.roll) > NEUTRAL_EPS ||
      Math.abs(o.yawOff) > NEUTRAL_EPS ||
      Math.abs(o.eyeY) > NEUTRAL_EPS ||
      Math.abs(o.eyeF) > NEUTRAL_EPS ||
      this.slideX !== 0 ||
      this.slideY !== 0 ||
      this.slideZ !== 0 ||
      Math.abs(o.fovPct) > NEUTRAL_EPS ||
      Math.abs(o.follow - 1) > 0.002 ||
      Math.abs(o.mouseYaw - 1) > 0.002 ||
      Math.abs(o.mousePitch - 1) > 0.002 ||
      o.vignette > 0.002 ||
      o.flash > 0.002;
  }
}
