/**
 * Champions League — headless, deterministic platform-fighter simulation (plan §2).
 *
 * `new BrawlWorld(config, seed, source?)` implements `BrawlWorldApi`. Pure function of
 * (config, seed, intents): fixed 60 Hz step, no DOM/three/Date/Math.random, randomness only through
 * the seeded mulberry32 (used once per respawn to pick the facing of a fighter that materialises on
 * the stage centre line). Constants live in `../config.ts` (`PHYS`). Move/stage data comes from
 * `source` (default: the shipped registry in `../data`; tests inject fixtures).
 *
 * ── Step order (per live frame) ──────────────────────────────────────────────────────────────
 *   frame++ → platform positions (pure function of the frame; riders are CARRIED by the platform's
 *   displacement, never launched by its velocity) → latch inputs into the 5-frame buffer →
 *   update every fighter in id order (state machines, physics) → hit detection on the post-update
 *   state of ALL fighters (so simultaneous hits trade) → apply hits in attacker/victim order →
 *   blast-zone KOs → match end (stocks / time).
 *
 * ── Decisions on details the plan leaves open (all tunables are in PHYS) ─────────────────────
 *  • Countdown: the first 180 frames only advance the frame counter; `time` is negative until live.
 *  • Inputs: `setIntent` OR-accumulates edge flags until the next step; presses are buffered 5 frames
 *    (jump/light/heavy/dodge) with the stick direction captured at the press.
 *  • Short hop: only if `jumpHeld` was observed true (the press tick counts as held when the
 *    controller reports it) and is then released within the squat + 6 frames after takeoff. A bot
 *    that never reports `jumpHeld` always gets full-height jumps.
 *  • Attack direction & turn: see plan §2.3; side moves turn toward moveX unless the body has
 *    `armor` ("armor-locked"); `turnOnStart` overrides either way. Chain links never turn.
 *  • Move data conventions: `motion.set` replaces velocity every frame of the window, otherwise the
 *    velocity is ADDED each frame; `vx` is forward-relative. `path` keys are move-relative frames,
 *    linearly interpolated, clamped at both ends, offsets added to the box (and its sweetspot).
 *    `sweet` is fighter-local like the box and tested against the victim's hurtbox centre.
 *  • Aerial landing: autoCancel window [from,to) → no lag; otherwise `landingLag` (default 8 light /
 *    18 heavy) in the locked `landing` action. Ground-form moves that leave the ground keep going.
 *  • Armor: default dmgScale = 1; an absorbed hit still gives hitlag to both, counts as a connect
 *    for cancels/staling/damage stats, and emits a `hit` event with kbSpeed 0. Move `invuln` windows
 *    behave like dodge invulnerability.
 *  • Effects: `pull` = horizontal pull toward the attacker (speed ≤ 7), `stun` = +12 hitstun and no
 *    tumble, `flinch` = hitstun ≤ 16 and no tumble, `bury` = grounded victims with kb ≤ 24 are held
 *    in `knockdown` for 30 frames instead of launched. Grounded victims with a downward launch are
 *    bounced up (80 %); grounded victims with |vy| < 0.5 m/s slide (friction ×0.9/frame).
 *  • Tumble landing on a floor → `knockdown` (22 f, hittable) → `getup` (14 f, 10 f invulnerable).
 *  • DI: while in hitstun the held direction rotates the velocity toward it, at most 2.4°/frame at
 *    full perpendicular input, total ±12° per hit.
 *  • Staling: a connected move pushes its MoveId once per activation (a light-neutral string counts
 *    once); the queue keeps the last 6.
 *  • Ledge grab uses the hand point (0.95 × height above the feet) and the body edge nearest the
 *    corner; hang position hugs the corner; a ledge is "free" if nobody hangs/climbs on it.
 *  • v1.6 ledge AUTO-GRAB ASSIST: besides the original box (falling, vy ≤ 0.5), a free actionable airborne fighter (not holding Down,
 *    `ledgeRegrab` and `assistCd` elapsed) whose hand point is in the larger zone under / beside the corner
 *    (`PHYS.ledgeAssistOut/Down/Up`) AND is moving toward / holding toward the stage grabs automatically — also while still rising.
 *    The grab itself is the normal one (snap to the hang pose, same invulnerability decay / max hang / regrab rules).
 *  • v1.6 BURROW: a ground move body with `burrow: {from, to}` is "underground" while `moveFrame` is inside the window
 *    (`Fighter.isUnderground`, derived from saved state, exposed as `BrawlFighterState.underground`): hits skip the fighter
 *    exactly like dodge invulnerability (no hit, no hitlag, no armor interaction), other hitboxes pass through it. A motion
 *    window with `stopAtEdge` keeps a GROUNDED fighter on its platform (the feet centre stays inside [x0, x1] of the platform it
 *    stands on, moving platforms included; the travel stops there with vx = 0), and when the burrow window ends the fighter
 *    surfaces standing still (vx = 0, no slide), so it can never be carried off a ledge.
 *    Ledge jump = full `jumpVel` and does not consume an air jump; the grab refills air jumps.
 *    Climb has 12 frames of invulnerability; roll-up is invulnerable throughout.
 *  • v1.6 DYNAMIC STAGES (docs/CL-MAPS-PLAN.md):
 *      - PATH MOTION: a platform's position is a pure function of the frame (`geometry.platformAtFrame`: defined position + `moving` offset +
 *        cosine-eased `path` offset). Grounded riders are carried by the platform's displacement of the frame (never launched by its
 *        velocity) — also during the countdown, in hitlag and after `skipCountdown()`.
 *      - SOLID MOVING PLATFORMS: after the platforms moved, every non-rider fighter overlapping a platform that MOVED this frame is pushed out
 *        along the axis of minimal penetration (up / sideways; down only for airborne fighters — a grounded fighter is never pushed through its
 *        floor), its velocity component into the platform zeroed; if that pushes it into another solid ("squeezed") it is lifted onto that
 *        solid's surface instead. Static solids never trigger the pass, so existing stages behave exactly as before. Ledges / hang positions /
 *        the ledge-assist zone are computed from the current corner, so they move with the platform.
 *      - BREAKABLES: an attacker's damaging hitbox that overlaps a breakable platform's rect (expanded by PHYS.platHitPad) counts ONE hit per
 *        attack activation (`Fighter.actSerial`) and per platform, with ≥ PHYS.platHitCooldown frames between counts of one attacker on one
 *        platform (so a multi-hit box or a light string counts once; armor / absorbed / whiffed attacks count too — it is attack based). Counts
 *        are applied after the fighter hits of the frame, in attacker order: `platformHit` (hpLeft / maxHp), and at 0 `platformBreak` — the
 *        platform stops colliding that frame, riders start falling (normal air physics), hanging / climbing fighters drop, jump-squats are
 *        cancelled. When the LAST breakable is destroyed `stageFinal` is emitted once and every `finalOnly` platform becomes active (fighters
 *        embedded in a newly active solid are pushed out like above).
 *      - LEDGE EXPOSURE: a ledge is grabbable only while its platform is active and its corner is not covered by another active platform at the
 *        same height (PHYS.ledgeCover*); a fighter hanging from a platform that breaks drops.
 *  • Air drag: ×0.98/frame with no stick input, and also while above airSpeed in the stick's own
 *    direction (after a launch); there is no other cap on launch speeds (they only decay by this drag
 *    and, in hitstun, by ×0.985/frame). Opposing the launch brakes at airAccel.
 *  • Jumps: `jumpsLeft` counts ALL jumps left incl. the ground jump while grounded (= maxJumps);
 *    leaving the ground without jumping spends the ground jump (maxJumps − 1).
 *  • Respawn: the hover platform is virtual (centre = stage.respawn, half width 1.4 m): the fighter
 *    can walk on it, drops with Down / by leaving its edge / after 180 f, and ends early (≥ 40 f)
 *    on jump/attack/dodge. Dropping from it leaves maxJumps − 1 air jumps; jumping off leaves
 *    maxJumps − 1 after the jump.
 *  • Match end: ≥ 2 fighters → last one with stocks wins (all out at once = draw, winnerId −1);
 *    a solo roster ends when its stocks are gone. Time up → most stocks → lowest percent → draw.
 *    Once over, `step()` is a no-op.
 *
 * Extensions beyond `BrawlWorldApi` (not part of the contract): `stage`, `seed`, `skipCountdown()`,
 * and the `debug*` helpers used by tests / tooling.
 *
 * ── Online rollback support (v1.5, additive) ─────────────────────────────────────────────────
 * The simulation is bit-deterministic across machines: it uses only `+ − × ÷`, comparisons and exactly-specified
 * `Math.*` (sqrt/abs/min/max/floor/round, imul) — trigonometry comes from `./dmath` and the RNG is the serialisable
 * `SimRng` (tests/brawl/determinism.scan.test.ts enforces this on every file under sim/). On top of that:
 * `frame`, `isOver`, `saveState(into?)` / `loadState(s)` (full gameplay state, pooled buffers), `checksum()`
 * (32-bit, canonical order) and `forfeit(id)` (idempotent, removes a fighter like a final KO without crediting anyone).
 * Events are NOT part of the saved state: drain them after every step (`loadState` discards any pending ones).
 */

import { SimRng } from './rng';
import { dhypot } from './dmath';
import { StateIO, createSavedState, hashWords } from './stateIO';
import type { BrawlSavedState } from './stateIO';
import type {
  BrawlEvent,
  BrawlIntent,
  BrawlMatchConfig,
  BrawlSnapshot,
  BrawlWorldApi,
  Facing,
  HitboxDef,
  HitboxView,
  MoveBody,
  MoveId,
  PlatformDef,
  PlatformState,
  StageDef,
} from '../types';
import { PHYS } from '../config';
import { DEFAULT_DATA_SOURCE } from './dataSource';
import type { BrawlDataSource } from './dataSource';
import { Fighter, NO_BUF } from './Fighter';
import { applyDI, computeHit, staleMultiplier } from './combat';
import { circleRect, clampNum, makePlatRT, platformAtFrame, rectRect, supportedBy } from './geometry';
import type { PlatRT } from './geometry';

interface LedgeRT {
  plat: number;
  /** −1 = left end of the platform, +1 = right end. */
  side: -1 | 1;
}

interface ActiveBox {
  idx: number;
  hb: HitboxDef;
  cx: number;
  cy: number;
  /** Path offset applied this frame (also moves the sweetspot). */
  px: number;
  py: number;
  /** Scratch: overlapped the current victim this frame. */
  hit: boolean;
}

interface PendingHit {
  a: Fighter;
  v: Fighter;
  moveId: MoveId;
  hb: HitboxDef;
  cx: number;
  cy: number;
  sweet: boolean;
}

interface PendingPlatHit {
  j: number;
  attackerId: number;
  x: number;
  y: number;
}

const LIGHT_IDS: Record<string, MoveId> = { N: 'lightN', S: 'lightS', D: 'lightD', U: 'lightU' };
const HEAVY_IDS: Record<string, MoveId> = { N: 'heavyN', S: 'heavyS', D: 'heavyD', U: 'heavyU' };

function sgn(v: number): 1 | -1 {
  return v < 0 ? -1 : 1;
}

function sanitize(v: number): number {
  return Number.isFinite(v) ? (v < -1 ? -1 : v > 1 ? 1 : v) : 0;
}

function moveToward(v: number, target: number, rate: number): number {
  return v < target ? (v + rate > target ? target : v + rate) : v - rate < target ? target : v - rate;
}

/** Attack slot from the stick at the button edge (plan §2.3). */
function slotOf(dx: number, dy: number): 'N' | 'S' | 'D' | 'U' {
  if (dy > 0.5) return 'U';
  if (dy < -0.5) return 'D';
  if (Math.abs(dx) > PHYS.turnThreshold) return 'S';
  return 'N';
}

export class BrawlWorld implements BrawlWorldApi {
  readonly config: BrawlMatchConfig;
  readonly seed: number;
  readonly stage: StageDef;

  private readonly src: BrawlDataSource;
  private readonly rng: SimRng;
  private readonly defs: PlatformDef[];
  private readonly plat: PlatRT[];
  private readonly ledges: LedgeRT[] = [];
  /** Fighter id hanging/climbing on each ledge, −1 = free. */
  private readonly ledgeOwner: number[] = [];
  /** v1.6: indices of the breakable platforms, and a destroyed-everything flag (the stage is in its FINAL form). */
  private readonly breakIdx: number[] = [];
  private finalForm = false;
  private readonly platPending: PendingPlatHit[] = [];
  private readonly fighters: Fighter[] = [];
  private readonly timeLimitFrames: number;

  private frameNo = 0;
  private over = false;
  private winner = -1;
  private events: BrawlEvent[] = [];
  private hitViews: HitboxView[] = [];
  private readonly boxes: ActiveBox[] = [];
  private readonly pending: PendingHit[] = [];
  private readonly io = new StateIO();
  private scratch: BrawlSavedState | null = null;

  constructor(config: BrawlMatchConfig, seed: number, source: BrawlDataSource = DEFAULT_DATA_SOURCE) {
    this.config = config;
    this.seed = seed;
    this.src = source;
    this.rng = new SimRng(seed);
    this.stage = source.getStage(config.stage);
    this.defs = this.stage.platforms;
    this.plat = this.defs.map(makePlatRT);
    for (let i = 0; i < this.defs.length; i++) {
      const d = this.defs[i];
      platformAtFrame(d, 0, this.plat[i]);
      if (d.breakable) this.breakIdx.push(i);
      if (d.kind === 'solid') {
        if (d.ledgeLeft) {
          this.ledges.push({ plat: i, side: -1 });
          this.ledgeOwner.push(-1);
        }
        if (d.ledgeRight) {
          this.ledges.push({ plat: i, side: 1 });
          this.ledgeOwner.push(-1);
        }
      }
    }
    const stocks = Math.max(1, Math.floor(config.stocks) || 1);
    const n = config.roster.length;
    this.timeLimitFrames = config.timeLimitS > 0 ? Math.round(config.timeLimitS * 60) : 0;
    for (let i = 0; i < n; i++) {
      const r = config.roster[i];
      const f = new Fighter(i, r.animal, r.isPlayer, source.getMoveset(r.animal), stocks);
      f.platAct = new Array<number>(this.defs.length).fill(-1);
      f.platFrame = new Array<number>(this.defs.length).fill(-100000);
      const sp = this.stage.spawns[i % this.stage.spawns.length];
      f.pos.x = sp.x;
      f.pos.y = sp.y;
      f.facing = sp.x < 0 ? 1 : sp.x > 0 ? -1 : i % 2 === 0 ? 1 : -1;
      this.settle(f);
      this.fighters.push(f);
    }
  }

  // ── public API ───────────────────────────────────────────────────────────

  setIntent(id: number, intent: BrawlIntent): void {
    const f = this.fighters[id];
    if (!f) return;
    f.inX = sanitize(intent.moveX);
    f.inY = sanitize(intent.moveY);
    f.inJumpHeld = !!intent.jumpHeld;
    if (intent.jump) f.pendJump = true;
    if (intent.light) f.pendLight = true;
    if (intent.heavy) f.pendHeavy = true;
    if (intent.dodge) f.pendDodge = true;
  }

  step(): void {
    if (this.over) return;
    this.frameNo++;
    this.updatePlatforms();
    if (this.frameNo <= PHYS.countdownFrames) {
      for (const f of this.fighters) {
        this.clearPending(f);
        this.carryRider(f);
      }
      return;
    }
    this.pushOutOfMovedSolids();
    for (const f of this.fighters) this.latchInput(f);
    for (const f of this.fighters) this.updateFighter(f);
    this.resolveHits();
    this.checkBlast();
    this.checkMatchEnd();
  }

  snapshot(): BrawlSnapshot {
    const time = (this.frameNo - PHYS.countdownFrames) * PHYS.dt;
    const limit = this.config.timeLimitS;
    return {
      frame: this.frameNo,
      time,
      countdown: this.frameNo < PHYS.countdownFrames ? (PHYS.countdownFrames - this.frameNo) * PHYS.dt : 0,
      timeLeft: limit > 0 ? Math.max(0, limit - Math.max(0, time)) : null,
      fighters: this.fighters.map((f) => f.toState(f.platIdx >= 0 ? this.defs[f.platIdx].id : null)),
      platforms: this.plat.map((p, i) => this.platformState(p, i)),
      hitboxes: this.hitViews.map((h) => ({ ...h })),
      matchOver: this.over,
      winnerId: this.over ? this.winner : -1,
    };
  }

  drainEvents(): BrawlEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ── online rollback support ──────────────────────────────────────────────

  /** Current sim frame (0 = before the first step; the countdown occupies frames 1…180). */
  get frame(): number {
    return this.frameNo;
  }

  /** True once the match has been decided (`step()` is then a no-op). */
  get isOver(): boolean {
    return this.over;
  }

  /**
   * Capture the complete gameplay state. Pass the object returned by an earlier call as `into` to reuse its buffers
   * (no allocation in steady state). Undrained events are not part of the state.
   */
  saveState(into?: BrawlSavedState): BrawlSavedState {
    const s = into ?? createSavedState();
    this.io.beginWrite(s);
    this.syncState(this.io);
    this.io.endWrite(s);
    s.frame = this.frameNo;
    const n = this.fighters.length;
    s.bodies.length = n;
    for (let i = 0; i < n; i++) s.bodies[i] = this.fighters[i].body;
    s.hitViews = this.hitViews;
    return s;
  }

  /** Restore a state captured by {@link saveState} on a world built from the same config / seed. Pending events are dropped. */
  loadState(s: BrawlSavedState): void {
    this.io.beginRead(s);
    this.syncState(this.io);
    if (this.io.pos !== s.len) throw new Error(`BrawlWorld.loadState: state layout mismatch (${this.io.pos} != ${s.len})`);
    const n = this.fighters.length;
    for (let i = 0; i < n; i++) this.fighters[i].body = s.bodies[i] ?? null;
    this.hitViews = s.hitViews as HitboxView[];
    this.events = [];
  }

  /**
   * 32-bit checksum of the complete gameplay state in canonical order (integer mixing of the float bit patterns, so it
   * is identical on every machine). Equal to `checksumOfSaved(saveState())`.
   */
  checksum(): number {
    if (this.scratch === null) this.scratch = createSavedState();
    const s = this.scratch;
    this.io.beginWrite(s);
    this.syncState(this.io);
    this.io.endWrite(s);
    return hashWords(s.words, s.len);
  }

  /**
   * Remove a fighter from play like a final KO — no stock bookkeeping beyond zeroing it, no KO credit, no fall counted —
   * and re-evaluate the match end. Idempotent; a no-op once the match is over or the fighter is already out.
   */
  forfeit(id: number): void {
    const f = this.fighters[id];
    if (!f || this.over) return;
    if (!f.alive && f.stocks === 0) return;
    const wasAlive = f.alive;
    const b = this.stage.blast;
    this.releaseLedge(f);
    f.stocks = 0;
    f.alive = false;
    f.percent = 0;
    f.pos.x = clampNum(f.pos.x, b.left, b.right);
    f.pos.y = clampNum(f.pos.y, b.bottom, b.top);
    f.vel.x = 0;
    f.vel.y = 0;
    f.grounded = false;
    f.platIdx = -1;
    f.hitstun = 0;
    f.hitlag = 0;
    f.invuln = 0;
    f.body = null;
    f.moveId = null;
    f.moveChain = 0;
    f.moveFrame = 0;
    f.moveFrames = 0;
    f.movePhase = null;
    f.pendingTumble = false;
    f.respawnIn = 0;
    f.inX = 0;
    f.inY = 0;
    f.inJumpHeld = false;
    this.clearPending(f);
    f.bufJump = f.bufLight = f.bufHeavy = f.bufDodge = NO_BUF;
    this.setAction(f, 'ko', 0);
    if (wasAlive) {
      this.emit({ type: 'ko', fighterId: f.id, killerId: -1, side: 'bottom', pos: { x: f.pos.x, y: f.pos.y }, stocksLeft: 0 });
    }
    this.checkMatchEnd();
  }

  /** Every mutable gameplay field in canonical order (write mode: save / checksum, read mode: load). */
  private syncState(io: StateIO): void {
    this.frameNo = io.n(this.frameNo);
    this.over = io.b(this.over);
    this.winner = io.n(this.winner);
    this.rng.setState(io.n(this.rng.getState()));
    this.finalForm = io.b(this.finalForm);
    for (let i = 0; i < this.ledgeOwner.length; i++) this.ledgeOwner[i] = io.n(this.ledgeOwner[i]);
    for (let i = 0; i < this.plat.length; i++) {
      const p = this.plat[i];
      p.x0 = io.n(p.x0);
      p.x1 = io.n(p.x1);
      p.y = io.n(p.y);
      p.dx = io.n(p.dx);
      p.dy = io.n(p.dy);
      p.active = io.b(p.active);
      p.hp = io.n(p.hp);
    }
    for (let i = 0; i < this.fighters.length; i++) this.fighters[i].sync(io);
  }

  // ── extensions (tests / tooling) ─────────────────────────────────────────

  /** Jump straight to the first live frame (skips the 3 s countdown). */
  skipCountdown(): void {
    if (this.frameNo < PHYS.countdownFrames) {
      this.frameNo = PHYS.countdownFrames;
      this.updatePlatforms();
      for (const f of this.fighters) this.carryRider(f);
    }
  }

  /** Teleport a fighter (velocity zeroed, state reset to a free idle/fall) — test helper. */
  debugPlace(id: number, x: number, y: number, vx = 0, vy = 0): void {
    const f = this.fighters[id];
    if (!f) return;
    this.releaseLedge(f);
    f.alive = true;
    f.pos.x = x;
    f.pos.y = y;
    f.vel.x = vx;
    f.vel.y = vy;
    f.grounded = false;
    f.platIdx = -1;
    f.action = 'fall';
    f.actionFrame = 0;
    f.actionFrames = 0;
    f.body = null;
    f.moveId = null;
    f.moveChain = 0;
    f.moveFrame = 0;
    f.moveFrames = 0;
    f.movePhase = null;
    f.hitstun = 0;
    f.hitlag = 0;
    f.invuln = 0;
    f.freeFall = false;
    f.fastFalling = false;
    this.settle(f);
    // teleported into the air = walked off a ledge: the ground jump is spent
    if (!f.grounded && f.jumpsLeft >= f.stats.maxJumps) f.jumpsLeft = f.stats.maxJumps - 1;
  }

  debugSetPercent(id: number, percent: number): void {
    const f = this.fighters[id];
    if (f) f.percent = clampNum(percent, 0, PHYS.percentCap);
  }

  debugSetStocks(id: number, stocks: number): void {
    const f = this.fighters[id];
    if (f) f.stocks = stocks;
  }

  debugSetFacing(id: number, facing: Facing): void {
    const f = this.fighters[id];
    if (f) f.facing = facing;
  }

  /**
   * Test / tooling helper: apply `count` counted hits by `attackerId` to breakable platform `platformId` through the normal pipeline
   * (`platformHit` / `platformBreak` / `stageFinal` events, falling riders, final form). Returns false for an unknown or non-breakable id.
   */
  debugHitPlatform(platformId: string, attackerId = 0, count = 1): boolean {
    const j = this.defs.findIndex((d) => d.id === platformId && d.breakable !== undefined);
    if (j < 0) return false;
    for (let n = 0; n < count; n++) {
      const p = this.plat[j];
      if (!p.active || p.hp <= 0) break;
      this.platPending.length = 0;
      this.platPending.push({ j, attackerId, x: (p.x0 + p.x1) * 0.5, y: p.y });
      this.applyPlatformHits();
    }
    this.platPending.length = 0;
    return true;
  }

  // ── setup helpers ────────────────────────────────────────────────────────

  /** If a platform surface is under the fighter's feet, stand on it (else it falls). */
  private settle(f: Fighter): void {
    for (let j = 0; j < this.plat.length; j++) {
      const p = this.plat[j];
      if (!p.active) continue;
      if (Math.abs(p.y - f.pos.y) < 0.05 && supportedBy(f.pos.x, f.stats.width, p.x0, p.x1)) {
        f.pos.y = p.y;
        f.grounded = true;
        f.platIdx = j;
        f.action = 'idle';
        f.jumpsLeft = f.stats.maxJumps;
        f.groundedFrames = 0;
        return;
      }
    }
    f.grounded = false;
    f.platIdx = -1;
  }

  private updatePlatforms(): void {
    for (let i = 0; i < this.plat.length; i++) {
      const p = this.plat[i];
      const px = p.x0;
      const py = p.y;
      platformAtFrame(this.defs[i], this.frameNo, p);
      p.dx = p.x0 - px;
      p.dy = p.y - py;
    }
  }

  /** Public state of platform `i`: breakable / final-only platforms also report `active`, `hp`, `maxHp`. */
  private platformState(p: PlatRT, i: number): PlatformState {
    const d = this.defs[i];
    const out: PlatformState = { id: p.id, x0: p.x0, x1: p.x1, y: p.y };
    if (d.breakable || d.finalOnly) out.active = p.active;
    if (d.breakable) {
      out.hp = p.hp;
      out.maxHp = p.maxHp;
    }
    return out;
  }

  /** A grounded fighter follows its platform's displacement of this frame (used where `integrate` does not run: countdown, hitlag). */
  private carryRider(f: Fighter): void {
    if (!f.alive || !f.grounded || f.platIdx < 0) return;
    const p = this.plat[f.platIdx];
    if (!p.active || (p.dx === 0 && p.dy === 0)) return;
    f.pos.x += p.dx;
    f.pos.y = p.y;
  }

  /** True while `f` is locked to a ledge (hang / climb) — its position is rebuilt from the platform corner every frame. */
  private onLedge(f: Fighter): boolean {
    return f.ledgeIdx >= 0 && (f.action === 'ledgeHang' || f.action === 'ledgeClimb');
  }

  /**
   * Fighters overlapping a SOLID platform that moved this frame are pushed out (see the header). Riders of the platform are skipped (they are
   * carried by `integrate`), as are fighters locked to a ledge, hovering at the respawn point and dead ones.
   */
  private pushOutOfMovedSolids(): void {
    for (let j = 0; j < this.plat.length; j++) {
      const p = this.plat[j];
      if (!p.solid || !p.active || (p.dx === 0 && p.dy === 0)) continue;
      for (let i = 0; i < this.fighters.length; i++) this.pushOut(this.fighters[i], j, true);
    }
  }

  /**
   * Push fighter `f` out of solid platform `j` along the axis of minimal penetration (no-op when they do not overlap). `induced` = only
   * resolve an overlap that the platform's own move of this frame created: a fighter that was already inside the platform's previous rect
   * got there by its own motion (e.g. a wide body clipping a corner while it falls) and is left to the gentle push-out of `moveX`.
   */
  private pushOut(f: Fighter, j: number, induced: boolean): void {
    if (!f.alive || f.action === 'respawn' || this.onLedge(f)) return;
    if (f.grounded && f.platIdx === j) return;
    const p = this.plat[j];
    const eps = PHYS.eps;
    const hw = f.stats.width * 0.5;
    const h = f.stats.height;
    const bottom = p.y - p.thickness;
    const fx0 = f.pos.x - hw;
    const fx1 = f.pos.x + hw;
    const fy0 = f.pos.y;
    const fy1 = fy0 + h;
    if (!(fx1 > p.x0 + eps && fx0 < p.x1 - eps && fy1 > bottom + eps && fy0 < p.y - eps)) return;
    if (induced && fx1 > p.x0 - p.dx + eps && fx0 < p.x1 - p.dx - eps && fy1 > bottom - p.dy + eps && fy0 < p.y - p.dy - eps) return;
    // a grounded fighter keeps its own floor: it can only be pushed sideways (never lifted off it or pressed through it); an airborne
    // one is only lifted onto the platform if it could stand there (otherwise it would fall straight back through the corner)
    const up = f.grounded || !supportedBy(f.pos.x, f.stats.width, p.x0, p.x1) ? Infinity : p.y - fy0;
    const right = p.x1 - fx0;
    const left = fx1 - p.x0;
    const down = f.grounded ? Infinity : fy1 - bottom;
    let best = up;
    let dir = 0; // 0 up, 1 right, 2 left, 3 down
    if (right < best) {
      best = right;
      dir = 1;
    }
    if (left < best) {
      best = left;
      dir = 2;
    }
    if (down < best) {
      best = down;
      dir = 3;
    }
    if (dir === 0) {
      f.pos.y = p.y;
    } else if (dir === 1) {
      f.pos.x = p.x1 + hw;
      if (f.vel.x < 0) f.vel.x = 0;
    } else if (dir === 2) {
      f.pos.x = p.x0 - hw;
      if (f.vel.x > 0) f.vel.x = 0;
    } else {
      f.pos.y = bottom - h;
      if (f.vel.y > 0) f.vel.y = 0;
    }
    this.resolveSqueeze(f, j);
  }

  /** After a push: if the fighter now overlaps ANOTHER solid (squeezed between two), lift it onto that solid's surface — deterministic, finite. */
  private resolveSqueeze(f: Fighter, from: number): void {
    const eps = PHYS.eps;
    const hw = f.stats.width * 0.5;
    const h = f.stats.height;
    for (let pass = 0; pass < this.plat.length; pass++) {
      let moved = false;
      for (let k = 0; k < this.plat.length; k++) {
        if (k === from) continue;
        const q = this.plat[k];
        if (!q.solid || !q.active) continue;
        if (f.pos.x + hw > q.x0 + eps && f.pos.x - hw < q.x1 - eps && f.pos.y + h > q.y - q.thickness + eps && f.pos.y < q.y - eps) {
          // lifted onto q's surface: airborne with its feet exactly on the top (the next move lands it), never "grounded" at a stale height
          f.pos.y = q.y;
          if (f.vel.y > 0) f.vel.y = 0;
          if (f.grounded) this.leaveGround(f);
          moved = true;
        }
      }
      if (!moved) return;
    }
  }

  private emit(e: BrawlEvent): void {
    this.events.push(e);
  }

  // ── input ────────────────────────────────────────────────────────────────

  private clearPending(f: Fighter): void {
    f.pendJump = f.pendLight = f.pendHeavy = f.pendDodge = false;
  }

  private latchInput(f: Fighter): void {
    if (!f.alive) {
      this.clearPending(f);
      f.bufJump = f.bufLight = f.bufHeavy = f.bufDodge = NO_BUF;
      return;
    }
    const B = PHYS.inputBuffer;
    if (f.bufJump >= 0 && ++f.bufJump > B) f.bufJump = NO_BUF;
    if (f.bufLight >= 0 && ++f.bufLight > B) f.bufLight = NO_BUF;
    if (f.bufHeavy >= 0 && ++f.bufHeavy > B) f.bufHeavy = NO_BUF;
    if (f.bufDodge >= 0 && ++f.bufDodge > B) f.bufDodge = NO_BUF;
    if (f.pendJump) f.bufJump = 0;
    if (f.pendLight) {
      f.bufLight = 0;
      f.lightDx = f.inX;
      f.lightDy = f.inY;
    }
    if (f.pendHeavy) {
      f.bufHeavy = 0;
      f.heavyDx = f.inX;
      f.heavyDy = f.inY;
    }
    if (f.pendDodge) {
      f.bufDodge = 0;
      f.dodgeDx = f.inX;
      f.dodgeDy = f.inY;
    }
    this.clearPending(f);
  }

  // ── per-fighter update ───────────────────────────────────────────────────

  private setAction(f: Fighter, a: Fighter['action'], frames: number): void {
    f.action = a;
    f.actionFrame = 0;
    f.actionFrames = frames;
  }

  /** Open-ended label (idle/walk/run/crouch/rise/fall/fastFall): only resets the frame counter on change. */
  private setStable(f: Fighter, a: Fighter['action']): void {
    if (f.action !== a) {
      f.action = a;
      f.actionFrame = 0;
    }
    f.actionFrames = 0;
  }

  private updateFighter(f: Fighter): void {
    if (!f.alive) {
      if (f.stocks > 0 && f.respawnIn > 0 && --f.respawnIn === 0) this.respawnFighter(f);
      return;
    }
    if (f.hitlag > 0) {
      f.hitlag--;
      this.carryRider(f);
      return;
    }
    f.actionFrame++;
    if (f.invuln > 0) f.invuln--;
    if (f.dodgeCd > 0) f.dodgeCd--;
    if (f.ledgeRegrab > 0) f.ledgeRegrab--;
    if (f.assistCd > 0) f.assistCd--;
    if (f.dropTimer > 0) f.dropTimer--;
    if (f.grounded) f.groundedFrames++;
    switch (f.action) {
      case 'hitstun':
      case 'tumble':
        this.updateHitstun(f);
        break;
      case 'attack':
        this.updateAttack(f);
        break;
      case 'dodgeSpot':
      case 'dodgeRoll':
      case 'dodgeAir':
        this.updateDodge(f);
        break;
      case 'jumpSquat':
        this.updateJumpSquat(f);
        break;
      case 'landing':
        this.updateLanding(f);
        break;
      case 'knockdown':
      case 'getup':
        this.updateDowned(f);
        break;
      case 'ledgeHang':
        this.updateLedgeHang(f);
        break;
      case 'ledgeClimb':
        this.updateLedgeClimb(f);
        break;
      case 'respawn':
        this.updateRespawn(f);
        break;
      case 'ko':
        break;
      default:
        this.updateFree(f);
    }
  }

  /** Actionable states: idle/walk/run/crouch (ground) and rise/fall/fastFall (air). */
  private updateFree(f: Fighter): void {
    const st = f.stats;
    // 1. dodge
    if (f.bufDodge >= 0 && f.dodgeCd <= 0 && !f.freeFall && this.startDodge(f)) {
      this.runDodgeFrame(f);
      return;
    }
    // 2. attack
    if (!f.freeFall && this.tryStartAttack(f)) {
      this.runAttackFrame(f);
      return;
    }
    // 3. jump
    if (f.bufJump >= 0) {
      if (f.grounded) {
        f.bufJump = NO_BUF;
        this.beginJumpSquat(f);
        this.updateJumpSquat(f);
        return;
      }
      if (f.jumpsLeft > 0 && !f.freeFall) {
        f.bufJump = NO_BUF;
        f.jumpsLeft--;
        f.vel.y = st.airJumpVel;
        f.fastFalling = false;
        f.hopWindow = 0;
        this.emit({ type: 'jump', fighterId: f.id, air: true, pos: { x: f.pos.x, y: f.pos.y } });
      }
    }
    // 4. movement
    if (f.grounded) this.groundMove(f);
    else this.airMove(f);
  }

  // ── ground movement ──────────────────────────────────────────────────────

  private groundHorizontal(f: Fighter, crouch: boolean): void {
    const st = f.stats;
    const ax = Math.abs(f.inX);
    let target = 0;
    if (!crouch && ax >= PHYS.moveDeadzone) target = (ax >= PHYS.walkThreshold ? st.runSpeed : st.walkSpeed) * sgn(f.inX);
    if (!crouch && ax > PHYS.turnThreshold) f.facing = f.inX > 0 ? 1 : -1;
    const vx = f.vel.x;
    const accelerating = target !== 0 && (vx === 0 || sgn(vx) === sgn(target)) && Math.abs(target) > Math.abs(vx);
    const rate = st.runSpeed / (accelerating ? PHYS.groundAccelFrames : PHYS.groundStopFrames);
    f.vel.x = moveToward(vx, target, rate);
  }

  private groundMove(f: Fighter): void {
    const st = f.stats;
    const down = f.inY < -PHYS.downThreshold;
    const p = this.plat[f.platIdx];
    if (down && !p.solid && f.groundedFrames >= PHYS.dropMinStandFrames) {
      f.dropPlat = f.platIdx;
      f.dropTimer = PHYS.dropThroughFrames;
      this.leaveGround(f);
      f.vel.y = PHYS.dropThroughVy;
      this.airMove(f);
      return;
    }
    this.groundHorizontal(f, down);
    let act: Fighter['action'];
    if (down) act = 'crouch';
    else if (Math.abs(f.inX) < PHYS.moveDeadzone && Math.abs(f.vel.x) < 0.3) act = 'idle';
    else act = Math.abs(f.vel.x) > st.walkSpeed * 1.05 ? 'run' : 'walk';
    this.setStable(f, act);
    this.integrate(f, 1, st.fallSpeed);
  }

  private beginJumpSquat(f: Fighter): void {
    this.setAction(f, 'jumpSquat', PHYS.jumpSquat);
    f.jumpWasHeld = f.inJumpHeld;
    f.jumpReleased = false;
  }

  private trackJumpHold(f: Fighter): void {
    if (f.inJumpHeld) f.jumpWasHeld = true;
    else if (f.jumpWasHeld) f.jumpReleased = true;
  }

  private updateJumpSquat(f: Fighter): void {
    const st = f.stats;
    this.trackJumpHold(f);
    if (f.actionFrame >= f.actionFrames) {
      // takeoff
      f.vel.y = st.jumpVel * (f.jumpReleased ? PHYS.shortHopCut : 1);
      f.hopCut = f.jumpReleased;
      f.hopWindow = PHYS.shortHopWindow;
      f.fastFalling = false;
      this.leaveGround(f);
      f.jumpsLeft = st.maxJumps - 1; // the ground jump counts as the first of maxJumps
      this.setStable(f, 'rise');
      this.emit({ type: 'jump', fighterId: f.id, air: false, pos: { x: f.pos.x, y: f.pos.y } });
      this.airMove(f);
      return;
    }
    this.groundHorizontal(f, false);
    this.integrate(f, 1, st.fallSpeed);
  }

  // ── air movement ─────────────────────────────────────────────────────────

  private airHorizontal(f: Fighter, accelMult: number, allowFacing: boolean): void {
    const st = f.stats;
    const ax = Math.abs(f.inX);
    if (allowFacing && ax > PHYS.airFacingThreshold) f.facing = f.inX > 0 ? 1 : -1;
    let vx = f.vel.x;
    if (ax >= PHYS.moveDeadzone) {
      // beyond airSpeed in the stick's own direction (after a launch) the stick adds nothing; only the 2 % drag acts
      if (Math.abs(vx) > st.airSpeed && sgn(vx) === sgn(f.inX)) vx *= PHYS.airDrag;
      else vx = moveToward(vx, f.inX * st.airSpeed, st.airAccel * PHYS.dt * accelMult);
    } else {
      vx *= PHYS.airDrag;
    }
    f.vel.x = vx;
  }

  private airMove(f: Fighter): void {
    const st = f.stats;
    if (f.hopWindow > 0) {
      f.hopWindow--;
      this.trackJumpHold(f);
      if (f.jumpReleased && !f.hopCut && f.vel.y > 0) {
        f.vel.y *= PHYS.shortHopCut;
        f.hopCut = true;
      }
    }
    this.airHorizontal(f, 1, true);
    if (f.inY < -PHYS.downThreshold && f.vel.y <= 0) f.fastFalling = true;
    let cap = f.fastFalling ? st.fastFallSpeed : st.fallSpeed;
    if (f.fastFalling && f.vel.y <= 0 && f.vel.y > -st.fastFallSpeed) f.vel.y = -st.fastFallSpeed;
    if (st.glideFall !== undefined && f.inJumpHeld && !f.fastFalling && f.vel.y <= 0 && st.glideFall < cap) cap = st.glideFall;
    this.integrate(f, 1, cap);
    if (f.grounded) return; // landed this frame (onLand set the label)
    this.setStable(f, f.fastFalling ? 'fastFall' : f.vel.y > 0.5 ? 'rise' : 'fall');
    this.tryLedgeGrab(f);
  }

  // ── physics core ─────────────────────────────────────────────────────────

  private leaveGround(f: Fighter): void {
    f.grounded = false;
    f.platIdx = -1;
    f.groundedFrames = 0;
    if (f.jumpsLeft >= f.stats.maxJumps) f.jumpsLeft = f.stats.maxJumps - 1;
  }

  /**
   * Advance position by velocity with platform collision. `gravMult` scales gravity (× the fighter's
   * own gravityMult); `fallCap` is the descent speed cap (Infinity = none, hitstun).
   */
  private integrate(f: Fighter, gravMult: number, fallCap: number): void {
    const dt = PHYS.dt;
    if (f.grounded && f.platIdx >= 0) {
      const p = this.plat[f.platIdx];
      f.pos.x += p.dx;
      f.pos.y = p.y;
    }
    if (f.grounded && f.vel.y > 0) this.leaveGround(f);
    if (!f.grounded) {
      f.vel.y -= PHYS.gravity * f.stats.gravityMult * gravMult * dt;
      if (fallCap !== Infinity && f.vel.y < -fallCap) {
        const ex = -fallCap - f.vel.y;
        f.vel.y = ex <= 1.2 ? -fallCap : f.vel.y + ex * PHYS.fallCapEase;
      }
    }
    f.vel.x = clampNum(f.vel.x, -PHYS.maxSpeed, PHYS.maxSpeed);
    f.vel.y = clampNum(f.vel.y, -PHYS.maxSpeed, PHYS.maxSpeed);
    this.moveX(f, f.vel.x * dt);
    if (f.grounded) this.checkSupport(f);
    else this.moveY(f);
  }

  /** Horizontal move with solid-platform side contact (blocks) and gentle push-out when embedded. */
  private moveX(f: Fighter, dxm: number): void {
    const hw = f.stats.width * 0.5;
    const eps = PHYS.eps;
    const y0 = f.pos.y;
    const y1 = y0 + f.stats.height;
    let x = f.pos.x + dxm;
    for (let j = 0; j < this.plat.length; j++) {
      const p = this.plat[j];
      if (!p.solid || !p.active) continue;
      if (!(y0 < p.y - eps && y1 > p.y - p.thickness + eps)) continue;
      const wasOverlap = f.pos.x + hw > p.x0 + eps && f.pos.x - hw < p.x1 - eps;
      const nowOverlap = x + hw > p.x0 && x - hw < p.x1;
      if (!nowOverlap) continue;
      // v1.6: a fighter that does not move horizontally cannot have run INTO the side (it only touches it, within rounding): never
      // "block" it by flipping it to the far side — with moving platforms that happened every time a pushed fighter rested against one
      if (!wasOverlap && dxm === 0) continue;
      if (!wasOverlap) {
        if (dxm > 0) x = p.x0 - hw;
        else x = p.x1 + hw;
        if (f.vel.x * dxm > 0) f.vel.x = 0;
      } else {
        const dir = f.pos.x < (p.x0 + p.x1) * 0.5 ? -1 : 1;
        const need = dir < 0 ? x + hw - p.x0 : p.x1 - (x - hw);
        x += dir * Math.min(PHYS.pushOutRate, need > 0 ? need : 0);
      }
    }
    f.pos.x = x;
  }

  /** Grounded: stay on the platform while supported, hop to a same-height neighbour, else leave. */
  private checkSupport(f: Fighter): void {
    const w = f.stats.width;
    const p = this.plat[f.platIdx];
    if (supportedBy(f.pos.x, w, p.x0, p.x1)) {
      f.pos.y = p.y;
      f.vel.y = 0;
      return;
    }
    for (let j = 0; j < this.plat.length; j++) {
      if (j === f.platIdx) continue;
      const q = this.plat[j];
      if (!q.active) continue;
      if (Math.abs(q.y - f.pos.y) < 0.05 && supportedBy(f.pos.x, w, q.x0, q.x1)) {
        f.platIdx = j;
        f.pos.y = q.y;
        f.vel.y = 0;
        return;
      }
    }
    this.leaveGround(f);
    f.vel.y = 0;
  }

  /** Airborne vertical move: land on tops (swept, relative to moving platforms), bonk on solid undersides. */
  private moveY(f: Fighter): void {
    const st = f.stats;
    const eps = PHYS.eps;
    const oldY = f.pos.y;
    let ny = oldY + f.vel.y * PHYS.dt;
    const x = f.pos.x;
    let landIdx = -1;
    let landY = -Infinity;
    for (let j = 0; j < this.plat.length; j++) {
      const p = this.plat[j];
      if (!p.active) continue;
      if (!p.solid && j === f.dropPlat && f.dropTimer > 0) continue;
      if (!supportedBy(x, st.width, p.x0, p.x1)) continue;
      if (oldY - (p.y - p.dy) >= -eps && ny - p.y <= eps && p.y > landY) {
        landIdx = j;
        landY = p.y;
      }
    }
    if (landIdx >= 0) {
      const impact = f.vel.y;
      f.pos.y = landY;
      f.vel.y = 0;
      f.grounded = true;
      f.platIdx = landIdx;
      this.onLand(f, impact);
      return;
    }
    if (f.vel.y > 0) {
      const hw = st.width * 0.5;
      for (let j = 0; j < this.plat.length; j++) {
        const p = this.plat[j];
        if (!p.solid || !p.active) continue;
        if (!(x + hw > p.x0 && x - hw < p.x1)) continue;
        const bottom = p.y - p.thickness;
        if (oldY + st.height <= bottom + eps && ny + st.height > bottom) {
          ny = bottom - st.height;
          f.vel.y = 0;
        }
      }
    }
    f.pos.y = ny;
  }

  private onLand(f: Fighter, impactVy: number): void {
    const st = f.stats;
    f.jumpsLeft = st.maxJumps;
    f.recoveryUsed = false;
    f.airDodgeUsed = false;
    f.freeFall = false;
    f.fastFalling = false;
    f.hopWindow = 0;
    f.groundedFrames = 0;
    f.dropPlat = -1;
    f.dropTimer = 0;
    this.emit({ type: 'land', fighterId: f.id, pos: { x: f.pos.x, y: f.pos.y }, hard: impactVy < -PHYS.hardLandVy });
    switch (f.action) {
      case 'tumble':
        this.enterKnockdown(f, PHYS.knockdownFrames);
        break;
      case 'hitstun':
        break;
      case 'attack': {
        if (!f.moveAir || !f.body) break;
        const b = f.body;
        const ac = b.autoCancel;
        const cancelled = ac !== undefined && f.moveFrame >= ac.from && f.moveFrame < ac.to;
        const lag = b.landingLag ?? ((f.moveId ?? 'lightN').startsWith('heavy') ? PHYS.landingLagHeavy : PHYS.landingLagLight);
        this.endMove(f);
        if (!cancelled && lag > 0) {
          this.setAction(f, 'landing', lag);
        } else {
          this.setStable(f, 'idle');
        }
        break;
      }
      case 'dodgeSpot':
      case 'dodgeRoll':
      case 'dodgeAir':
      case 'jumpSquat':
      case 'landing':
      case 'knockdown':
      case 'getup':
      case 'ledgeHang':
      case 'ledgeClimb':
      case 'respawn':
      case 'ko':
        break;
      default:
        this.setStable(f, 'idle');
    }
  }

  private enterKnockdown(f: Fighter, frames: number): void {
    this.setAction(f, 'knockdown', frames);
    f.hitstun = 0;
    f.pendingTumble = false;
    f.vel.x *= PHYS.knockdownSlide;
    f.vel.y = 0;
  }

  private updateLanding(f: Fighter): void {
    f.vel.x *= PHYS.groundSlideFriction;
    this.integrate(f, 1, f.stats.fallSpeed);
    if (!f.grounded) {
      this.setStable(f, 'fall');
      return;
    }
    if (f.actionFrame >= f.actionFrames) this.setStable(f, 'idle');
  }

  private updateDowned(f: Fighter): void {
    f.vel.x *= PHYS.groundSlideFriction;
    this.integrate(f, 1, f.stats.fallSpeed);
    if (!f.grounded) {
      this.setStable(f, 'fall');
      return;
    }
    if (f.actionFrame >= f.actionFrames) {
      if (f.action === 'knockdown') {
        this.setAction(f, 'getup', PHYS.getupFrames);
        if (f.invuln < PHYS.getupInvuln) f.invuln = PHYS.getupInvuln;
      } else {
        this.setStable(f, 'idle');
      }
    }
  }

  // ── dodge ────────────────────────────────────────────────────────────────

  private startDodge(f: Fighter): boolean {
    const st = f.stats;
    if (!f.grounded && f.airDodgeUsed) {
      f.bufDodge = NO_BUF;
      return false;
    }
    const dx = f.dodgeDx;
    const dy = f.dodgeDy;
    f.bufDodge = NO_BUF;
    f.dodgeCd = st.dodgeFrames + PHYS.dodgeCd;
    if (f.invuln < st.dodgeInvuln) f.invuln = st.dodgeInvuln;
    if (f.grounded) {
      if (Math.abs(dx) > PHYS.dodgeDirThreshold) {
        f.facing = dx > 0 ? 1 : -1;
        f.dodgeDir = f.facing;
        this.setAction(f, 'dodgeRoll', st.dodgeFrames);
        this.emit({ type: 'dodge', fighterId: f.id, kind: 'roll', pos: { x: f.pos.x, y: f.pos.y } });
      } else {
        f.dodgeDir = 0;
        this.setAction(f, 'dodgeSpot', st.dodgeFrames);
        this.emit({ type: 'dodge', fighterId: f.id, kind: 'spot', pos: { x: f.pos.x, y: f.pos.y } });
      }
    } else {
      f.airDodgeUsed = true;
      f.fastFalling = false;
      const len = dhypot(dx, dy);
      if (len > PHYS.dodgeDirThreshold) {
        f.vel.x = (dx / Math.max(1, len)) * PHYS.airDodgeSpeed;
        f.vel.y = (dy / Math.max(1, len)) * PHYS.airDodgeSpeed;
      } else {
        f.vel.x = 0;
        f.vel.y = 0;
      }
      this.setAction(f, 'dodgeAir', st.dodgeFrames);
      this.emit({ type: 'dodge', fighterId: f.id, kind: 'air', pos: { x: f.pos.x, y: f.pos.y } });
    }
    return true;
  }

  private runDodgeFrame(f: Fighter): void {
    const st = f.stats;
    switch (f.action) {
      case 'dodgeSpot':
        f.vel.x *= PHYS.attackGroundFriction;
        this.integrate(f, 1, st.fallSpeed);
        break;
      case 'dodgeRoll':
        if (f.actionFrame < f.actionFrames - PHYS.rollStopFrames) f.vel.x = f.dodgeDir * PHYS.rollSpeed;
        else f.vel.x *= 0.5;
        this.integrate(f, 1, st.fallSpeed);
        break;
      default: // dodgeAir
        if (f.actionFrame > 0) {
          f.vel.x *= PHYS.airDodgeDecay;
          f.vel.y *= PHYS.airDodgeDecay;
        }
        this.integrate(f, 0, st.fallSpeed);
    }
  }

  private updateDodge(f: Fighter): void {
    if (f.actionFrame >= f.actionFrames) {
      const wasAir = f.action === 'dodgeAir';
      if (f.grounded) {
        this.setStable(f, 'idle');
      } else {
        if (wasAir) f.freeFall = true;
        this.setStable(f, 'fall');
      }
      this.updateFree(f);
      return;
    }
    this.runDodgeFrame(f);
  }

  // ── attacks ──────────────────────────────────────────────────────────────

  /** Most recent buffered attack press (heavy wins ties): 0 light, 1 heavy, −1 none. */
  private pickPress(f: Fighter): number {
    if (f.bufHeavy >= 0 && (f.bufLight < 0 || f.bufHeavy <= f.bufLight)) return 1;
    if (f.bufLight >= 0) return 0;
    return -1;
  }

  private consumePress(f: Fighter, kind: number): void {
    if (kind === 1) f.bufHeavy = NO_BUF;
    else f.bufLight = NO_BUF;
  }

  private tryStartAttack(f: Fighter): boolean {
    const kind = this.pickPress(f);
    if (kind < 0) return false;
    const dx = kind === 1 ? f.heavyDx : f.lightDx;
    const dy = kind === 1 ? f.heavyDy : f.lightDy;
    const slot = slotOf(dx, dy);
    const id = (kind === 1 ? HEAVY_IDS : LIGHT_IDS)[slot];
    this.consumePress(f, kind);
    return this.startAttack(f, id, 0, dx);
  }

  private startAttack(f: Fighter, id: MoveId, chain: number, dx: number): boolean {
    const md = f.moveset.moves[id];
    if (!md) return false;
    const air = chain === 0 && !f.grounded; // string links are ground-only bodies
    if (air ? md.groundOnly : md.airOnly) return false;
    if (id === 'heavyU' && air && f.recoveryUsed) return false;
    const body = this.src.getMoveBody(f.animal, id, air, chain);
    if (!body) return false;
    if (id === 'heavyU' && air) f.recoveryUsed = true;
    if (chain === 0) {
      const slotS = id.endsWith('S');
      const turn = body.turnOnStart ?? (slotS && !body.armor);
      if (turn && Math.abs(dx) > (slotS ? PHYS.turnThreshold : PHYS.moveDeadzone)) f.facing = dx > 0 ? 1 : -1;
    }
    f.body = body;
    f.moveId = id;
    f.moveChain = chain;
    f.moveAir = air;
    f.moveFrame = 0;
    f.moveFrames = body.startup + body.active + body.recovery;
    f.movePhase = 'startup';
    f.armorLeft = body.armor ? body.armor.hits : 0;
    f.moveConnected = false;
    f.movePushed = chain > 0;
    f.actSerial++;
    let maxGroup = 0;
    for (let i = 0; i < body.hitboxes.length; i++) {
      const g = body.hitboxes[i].group ?? i;
      if (g > maxGroup) maxGroup = g;
    }
    f.hitReg = new Array((maxGroup + 1) * this.fighters.length).fill(-1);
    this.setAction(f, 'attack', f.moveFrames);
    f.fastFalling = false;
    f.hopWindow = 0;
    this.emit({ type: 'moveStart', fighterId: f.id, moveId: id, chain, air });
    return true;
  }

  private endMove(f: Fighter): void {
    f.body = null;
    f.moveId = null;
    f.moveChain = 0;
    f.moveAir = false;
    f.moveFrame = 0;
    f.moveFrames = 0;
    f.movePhase = null;
    f.armorLeft = 0;
    this.setStable(f, f.grounded ? 'idle' : 'fall');
  }

  private updateAttack(f: Fighter): void {
    f.moveFrame++;
    f.actionFrame = f.moveFrame;
    if (f.moveFrame >= f.moveFrames) {
      this.endMove(f);
      this.updateFree(f);
      return;
    }
    this.tryCancel(f);
    this.runAttackFrame(f);
  }

  private tryCancel(f: Fighter): void {
    const body = f.body;
    if (!body || !body.cancels || body.cancels.length === 0) return;
    const kind = this.pickPress(f);
    if (kind < 0) return;
    const dx = kind === 1 ? f.heavyDx : f.lightDx;
    const dy = kind === 1 ? f.heavyDy : f.lightDy;
    const id = (kind === 1 ? HEAVY_IDS : LIGHT_IDS)[slotOf(dx, dy)];
    const mf = f.moveFrame;
    let ok = false;
    for (const c of body.cancels) {
      if (mf >= c.from && mf < c.to && (!c.onHitOnly || f.moveConnected) && c.into.includes(id)) {
        ok = true;
        break;
      }
    }
    if (!ok) return;
    const md = f.moveset.moves[f.moveId as MoveId];
    let chain = 0;
    if (id === f.moveId && !f.moveAir && md && md.chain && md.chain.length > f.moveChain) chain = f.moveChain + 1;
    if (this.startAttack(f, id, chain, dx)) this.consumePress(f, kind);
    else this.consumePress(f, kind);
  }

  /** Motion windows, drift/friction and physics for the current move frame. */
  private runAttackFrame(f: Fighter): void {
    const body = f.body as MoveBody;
    const mf = f.moveFrame;
    f.movePhase = mf < body.startup ? 'startup' : mf < body.startup + body.active ? 'active' : 'recovery';
    let gm = 1;
    let setX = false;
    let setY = false;
    let edge = false;
    if (body.motion) {
      for (const m of body.motion) {
        if (mf < m.from || mf >= m.to) continue;
        if (m.stopAtEdge) edge = true;
        const vx = m.vx !== undefined ? m.vx * f.facing : 0;
        const vy = m.vy ?? 0;
        if (m.set) {
          if (m.vx !== undefined) {
            f.vel.x = vx;
            setX = true;
          }
          if (m.vy !== undefined) {
            f.vel.y = vy;
            setY = true;
          }
        } else {
          f.vel.x += vx;
          f.vel.y += vy;
          if (m.vx !== undefined) setX = true;
          if (m.vy !== undefined) setY = true;
        }
        if (m.gravity !== undefined) gm = m.gravity;
      }
    }
    if (f.grounded) {
      if (!setX) f.vel.x *= PHYS.attackGroundFriction;
      // surfacing from a burrow: stand still (no slide past the spot where the tunnel ended)
      if (body.burrow !== undefined && !f.moveAir && mf === body.burrow.to) f.vel.x = 0;
    } else if (!setX) {
      this.airHorizontal(f, PHYS.airAttackDrift, false);
    }
    // `stopAtEdge`: never leave the platform stood on — plan this frame's step and stop at the end of the platform
    let edgePlat = -1;
    let edgeStop = false;
    if (edge && f.grounded && f.platIdx >= 0) {
      const p = this.plat[f.platIdx];
      const base = f.pos.x + p.dx;
      const want = base + f.vel.x * PHYS.dt;
      const lim = clampNum(want, p.x0, p.x1);
      if (lim !== want) {
        f.vel.x = (lim - base) / PHYS.dt;
        edgeStop = true;
      }
      edgePlat = f.platIdx;
    }
    this.integrate(f, gm, setY ? Infinity : f.stats.fallSpeed);
    if (edgePlat >= 0 && f.grounded && f.platIdx === edgePlat) {
      const p = this.plat[edgePlat];
      f.pos.x = clampNum(f.pos.x, p.x0, p.x1);
      if (edgeStop) f.vel.x = 0;
    }
  }

  // ── ledges ───────────────────────────────────────────────────────────────

  private hangPos(L: LedgeRT, f: Fighter, out: { x: number; y: number }): void {
    const p = this.plat[L.plat];
    const cx = L.side < 0 ? p.x0 : p.x1;
    out.x = cx + L.side * (f.stats.width * 0.5 + PHYS.ledgeHangOffset);
    out.y = p.y - f.stats.height * PHYS.ledgeHandFrac;
  }

  private releaseLedge(f: Fighter): void {
    if (f.ledgeIdx >= 0) {
      this.ledgeOwner[f.ledgeIdx] = -1;
      f.ledgeIdx = -1;
      f.ledgeRegrab = PHYS.ledgeRegrabCd;
      f.assistCd = PHYS.ledgeAssistRegrabCd;
    }
    if (!f.grounded) f.platIdx = -1;
  }

  /**
   * v1.6: can ledge `li` be grabbed right now? Its platform must be active and its corner exposed — not covered by another ACTIVE platform
   * at the same height (|Δy| ≤ PHYS.ledgeCoverDy) whose span, widened by PHYS.ledgeCoverTol, contains the corner x. On the original two stages
   * (no two platforms share a height) this is always true.
   */
  private ledgeOpen(li: number): boolean {
    const L = this.ledges[li];
    const p = this.plat[L.plat];
    if (!p.active) return false;
    const cx = L.side < 0 ? p.x0 : p.x1;
    for (let j = 0; j < this.plat.length; j++) {
      if (j === L.plat) continue;
      const q = this.plat[j];
      if (!q.active) continue;
      if (Math.abs(q.y - p.y) <= PHYS.ledgeCoverDy && cx >= q.x0 - PHYS.ledgeCoverTol && cx <= q.x1 + PHYS.ledgeCoverTol) return false;
    }
    return true;
  }

  private tryLedgeGrab(f: Fighter): void {
    if (this.ledges.length === 0 || f.ledgeRegrab > 0) return;
    if (f.inY < -PHYS.downThreshold) return;
    const st = f.stats;
    const hw = st.width * 0.5;
    const hy = f.pos.y + st.height * PHYS.ledgeHandFrac;
    const falling = f.vel.y <= PHYS.ledgeGrabMaxVy;
    const assist = f.assistCd <= 0;
    for (let li = 0; li < this.ledges.length; li++) {
      if (this.ledgeOwner[li] !== -1) continue;
      const L = this.ledges[li];
      const p = this.plat[L.plat];
      if (!p.active) continue;
      const cx = L.side < 0 ? p.x0 : p.x1;
      const near = f.pos.x - L.side * hw;
      // original grab box (needs a non-rising fighter)
      if (falling) {
        const lo = L.side < 0 ? cx - PHYS.ledgeBoxOut : cx - PHYS.ledgeBoxIn;
        const hi = L.side < 0 ? cx + PHYS.ledgeBoxIn : cx + PHYS.ledgeBoxOut;
        if (near >= lo && near <= hi && hy >= p.y - PHYS.ledgeBoxDown && hy <= p.y + PHYS.ledgeBoxUp && this.ledgeOpen(li)) {
          this.grabLedge(f, li, L);
          return;
        }
      }
      if (!assist) continue;
      // v1.6 assist zone: outside the platform end (`out` > 0) up to ledgeAssistOut, the hand from ledgeAssistDown below to ledgeAssistUp above the corner
      const out = L.side * (near - cx);
      if (out < -PHYS.ledgeBoxIn || out > PHYS.ledgeAssistOut) continue;
      if (hy < p.y - PHYS.ledgeAssistDown || hy > p.y + PHYS.ledgeAssistUp) continue;
      const toward = -L.side; // direction of the stage from this ledge
      if ((f.vel.x * toward > PHYS.ledgeAssistMinVx || f.inX * toward > PHYS.turnThreshold) && this.ledgeOpen(li)) {
        this.grabLedge(f, li, L);
        return;
      }
    }
  }

  private grabLedge(f: Fighter, li: number, L: LedgeRT): void {
    const hp = { x: 0, y: 0 };
    this.hangPos(L, f, hp);
    f.pos.x = hp.x;
    f.pos.y = hp.y;
    f.vel.x = 0;
    f.vel.y = 0;
    f.grounded = false;
    f.platIdx = L.plat;
    f.ledgeIdx = li;
    this.ledgeOwner[li] = f.id;
    f.facing = (L.side < 0 ? 1 : -1) as Facing;
    this.setAction(f, 'ledgeHang', PHYS.ledgeMaxHang);
    f.jumpsLeft = f.stats.maxJumps - 1;
    f.recoveryUsed = false;
    f.airDodgeUsed = false;
    f.freeFall = false;
    f.fastFalling = false;
    f.hopWindow = 0;
    // anti-stall: fewer invulnerable frames for every grab in the last 4 s
    let recent = 0;
    const keep: number[] = [];
    for (const g of f.grabFrames) {
      if (this.frameNo - g <= PHYS.ledgeInvulnWindow) {
        recent++;
        keep.push(g);
      }
    }
    keep.push(this.frameNo);
    f.grabFrames = keep;
    const inv = Math.max(0, PHYS.ledgeInvuln - PHYS.ledgeInvulnPenalty * recent);
    if (f.invuln < inv) f.invuln = inv;
    this.emit({ type: 'ledgeGrab', fighterId: f.id, pos: { x: f.pos.x, y: f.pos.y } });
  }

  private updateLedgeHang(f: Fighter): void {
    const L = this.ledges[f.ledgeIdx];
    if (!L) {
      this.setStable(f, 'fall');
      return;
    }
    if (!this.plat[L.plat].active) {
      this.dropFromLedge(f);
      return;
    }
    const hp = { x: 0, y: 0 };
    this.hangPos(L, f, hp);
    f.pos.x = hp.x;
    f.pos.y = hp.y;
    f.vel.x = 0;
    f.vel.y = 0;
    if (f.actionFrame >= PHYS.ledgeMaxHang) {
      this.dropFromLedge(f);
      return;
    }
    if (f.actionFrame < PHYS.ledgeMinHang) return;
    if (f.bufJump >= 0) {
      f.bufJump = NO_BUF;
      this.releaseLedge(f);
      f.grounded = false;
      f.vel.y = f.stats.jumpVel;
      f.vel.x = -L.side * PHYS.ledgeJumpDrift;
      f.hopWindow = 0;
      this.setStable(f, 'rise');
      this.emit({ type: 'jump', fighterId: f.id, air: false, pos: { x: f.pos.x, y: f.pos.y } });
      return;
    }
    if (f.bufDodge >= 0) {
      f.bufDodge = NO_BUF;
      this.startClimb(f, true);
      return;
    }
    if (f.inY > PHYS.downThreshold || f.inX * -L.side > PHYS.walkThreshold) {
      this.startClimb(f, false);
      return;
    }
    if (f.inY < -PHYS.downThreshold) this.dropFromLedge(f);
  }

  private dropFromLedge(f: Fighter): void {
    this.releaseLedge(f);
    f.grounded = false;
    f.vel.x = 0;
    f.vel.y = -2;
    this.setStable(f, 'fall');
  }

  private startClimb(f: Fighter, roll: boolean): void {
    f.climbRoll = roll;
    // v1.6: stored RELATIVE to the platform corner / top, so the climb follows a moving platform (identical to the absolute start on a static one)
    const L = this.ledges[f.ledgeIdx];
    const lp = this.plat[L.plat];
    f.climbFromX = f.pos.x - (L.side < 0 ? lp.x0 : lp.x1);
    f.climbFromY = f.pos.y - lp.y;
    const frames = roll ? PHYS.ledgeRollFrames : PHYS.ledgeClimbFrames;
    this.setAction(f, 'ledgeClimb', frames);
    const inv = roll ? frames : PHYS.ledgeClimbInvuln;
    if (f.invuln < inv) f.invuln = inv;
  }

  private updateLedgeClimb(f: Fighter): void {
    const L = this.ledges[f.ledgeIdx];
    if (!L) {
      this.setStable(f, 'fall');
      return;
    }
    if (!this.plat[L.plat].active) {
      this.dropFromLedge(f);
      return;
    }
    const p = this.plat[L.plat];
    const hw = f.stats.width * 0.5;
    const cx = L.side < 0 ? p.x0 : p.x1;
    let dest = cx - L.side * (hw + (f.climbRoll ? PHYS.ledgeRollDist : PHYS.ledgeClimbOffset));
    const lo = p.x0 + hw;
    const hi = p.x1 - hw;
    if (lo <= hi) dest = clampNum(dest, lo, hi);
    const t = Math.min(1, f.actionFrame / f.actionFrames);
    const split = f.climbRoll ? 0.3 : 0.55;
    const ty = Math.min(1, t / split);
    const tx = t <= split ? 0 : (t - split) / (1 - split);
    const easeY = ty * ty * (3 - 2 * ty);
    const fromX = cx + f.climbFromX;
    const fromY = p.y + f.climbFromY;
    f.pos.y = fromY + (p.y - fromY) * easeY;
    f.pos.x = fromX + (dest - fromX) * tx;
    f.vel.x = 0;
    f.vel.y = 0;
    if (f.actionFrame >= f.actionFrames) {
      this.ledgeOwner[f.ledgeIdx] = -1;
      f.ledgeIdx = -1;
      f.pos.x = dest;
      f.pos.y = p.y;
      f.grounded = true;
      f.platIdx = L.plat;
      f.groundedFrames = 0;
      f.jumpsLeft = f.stats.maxJumps;
      this.setStable(f, 'idle');
    }
  }

  // ── respawn ──────────────────────────────────────────────────────────────

  private respawnFighter(f: Fighter): void {
    const rp = this.stage.respawn;
    f.alive = true;
    f.pos.x = rp.x;
    f.pos.y = rp.y;
    f.vel.x = 0;
    f.vel.y = 0;
    f.grounded = false;
    f.platIdx = -1;
    f.facing = rp.x < 0 ? 1 : rp.x > 0 ? -1 : this.rng.next() < 0.5 ? 1 : -1;
    f.percent = 0;
    f.jumpsLeft = f.stats.maxJumps;
    f.hitstun = 0;
    f.hitlag = 0;
    f.hitstunTotal = 0;
    f.dodgeCd = 0;
    f.lastHitBy = -1;
    f.lastHitFrame = -100000;
    f.lastLaunch = null;
    f.freeFall = false;
    f.fastFalling = false;
    f.airDodgeUsed = false;
    f.recoveryUsed = false;
    f.pendingTumble = false;
    f.ledgeRegrab = 0;
    f.assistCd = 0;
    f.body = null;
    f.moveId = null;
    f.moveChain = 0;
    f.moveFrame = 0;
    f.moveFrames = 0;
    f.movePhase = null;
    f.staleQueue = [];
    f.bufJump = f.bufLight = f.bufHeavy = f.bufDodge = NO_BUF;
    f.invuln = PHYS.respawnInvuln;
    this.setAction(f, 'respawn', PHYS.respawnInvuln);
    this.emit({ type: 'respawn', fighterId: f.id, pos: { x: rp.x, y: rp.y } });
  }

  private updateRespawn(f: Fighter): void {
    const rp = this.stage.respawn;
    f.vel.x = 0;
    f.vel.y = 0;
    f.pos.y = rp.y;
    const ax = Math.abs(f.inX);
    let off = false;
    if (ax >= PHYS.moveDeadzone) {
      f.pos.x += f.inX * f.stats.walkSpeed * PHYS.respawnWalkMult * PHYS.dt;
      if (ax > PHYS.turnThreshold) f.facing = f.inX > 0 ? 1 : -1;
      if (Math.abs(f.pos.x - rp.x) > PHYS.respawnPlatformHalf) off = true;
    }
    const down = f.inY < -PHYS.downThreshold;
    const act = f.bufJump >= 0 || f.bufLight >= 0 || f.bufHeavy >= 0 || f.bufDodge >= 0;
    const early = f.actionFrame >= PHYS.respawnMinFrames && (act || down || off);
    if (f.invuln <= 0 || early) {
      f.invuln = 0;
      this.setStable(f, 'fall');
      f.jumpsLeft = f.stats.maxJumps;
      this.updateFree(f);
      if (f.jumpsLeft >= f.stats.maxJumps) f.jumpsLeft = f.stats.maxJumps - 1;
    }
  }

  // ── hitstun ──────────────────────────────────────────────────────────────

  private updateHitstun(f: Fighter): void {
    if (f.pendingTumble) {
      f.pendingTumble = false;
      f.action = 'tumble';
    }
    if (f.grounded && f.action === 'tumble') {
      this.enterKnockdown(f, PHYS.knockdownFrames);
      this.updateDowned(f);
      return;
    }
    if (f.grounded) {
      f.vel.x *= PHYS.groundSlideFriction;
    } else {
      const r = applyDI(f.vel.x, f.vel.y, f.inX, f.inY, f.diUsed);
      f.vel.x = r.vx * PHYS.hitstunDecayX;
      f.vel.y = r.vy;
      f.diUsed = r.used;
    }
    this.integrate(f, PHYS.hitstunGravityMult, Infinity);
    if (f.action !== 'hitstun' && f.action !== 'tumble') return; // knocked down by landing
    f.hitstun--;
    if (f.hitstun <= 0) {
      f.hitstun = 0;
      this.setStable(f, f.grounded ? 'idle' : 'fall');
    }
  }

  // ── hit detection & resolution ───────────────────────────────────────────

  private hurtTop(f: Fighter): number {
    return f.pos.y + (f.action === 'crouch' ? f.stats.height * PHYS.crouchHeightMult : f.stats.height);
  }

  private isInvulnerable(v: Fighter): boolean {
    if (v.invuln > 0) return true;
    if (v.action === 'attack' && v.body && v.body.invuln) {
      const w = v.body.invuln;
      if (v.moveFrame >= w.from && v.moveFrame < w.to) return true;
    }
    // v1.6: underground inside a burrow window — hits bypass the fighter
    return v.isUnderground();
  }

  private armorActive(v: Fighter): boolean {
    if (v.action !== 'attack' || !v.body || !v.body.armor || v.armorLeft <= 0) return false;
    const a = v.body.armor;
    return v.moveFrame >= a.from && v.moveFrame < a.to;
  }

  private pathOffset(hb: HitboxDef, mf: number, out: { x: number; y: number }): void {
    const path = hb.path;
    out.x = 0;
    out.y = 0;
    if (!path || path.length === 0) return;
    if (mf <= path[0].frame) {
      out.x = path[0].x;
      out.y = path[0].y;
      return;
    }
    for (let i = 1; i < path.length; i++) {
      const b = path[i];
      if (mf <= b.frame) {
        const a = path[i - 1];
        const span = b.frame - a.frame;
        const t = span > 0 ? (mf - a.frame) / span : 1;
        out.x = a.x + (b.x - a.x) * t;
        out.y = a.y + (b.y - a.y) * t;
        return;
      }
    }
    const last = path[path.length - 1];
    out.x = last.x;
    out.y = last.y;
  }

  private resolveHits(): void {
    this.hitViews = [];
    this.pending.length = 0;
    this.platPending.length = 0;
    const off = { x: 0, y: 0 };
    const nF = this.fighters.length;
    for (const a of this.fighters) {
      if (!a.alive || a.action !== 'attack' || !a.body || !a.moveId) continue;
      const body = a.body;
      const mf = a.moveFrame;
      this.boxes.length = 0;
      for (let i = 0; i < body.hitboxes.length; i++) {
        const hb = body.hitboxes[i];
        if (mf < hb.from || mf >= hb.to) continue;
        this.pathOffset(hb, mf, off);
        const cx = a.pos.x + a.facing * (hb.x + off.x);
        const cy = a.pos.y + hb.y + off.y;
        this.boxes.push({ idx: i, hb, cx, cy, px: off.x, py: off.y, hit: false });
        this.hitViews.push({
          fighterId: a.id,
          moveId: a.moveId,
          shape: hb.shape,
          x: cx,
          y: cy,
          r: hb.shape === 'circle' ? hb.r : 0,
          w: hb.shape === 'rect' ? hb.w : 0,
          h: hb.shape === 'rect' ? hb.h : 0,
        });
      }
      if (this.boxes.length === 0) continue;
      if (this.breakIdx.length > 0) this.collectPlatformHits(a);
      if (a.hitlag > 0) continue;
      for (const v of this.fighters) {
        if (v === a || !v.alive || this.isInvulnerable(v)) continue;
        const hw = v.stats.width * 0.5;
        const rx0 = v.pos.x - hw;
        const rx1 = v.pos.x + hw;
        const ry0 = v.pos.y;
        const ry1 = this.hurtTop(v);
        let best = -1;
        let bestDmg = -1;
        let nHit = 0;
        for (let k = 0; k < this.boxes.length; k++) {
          const bx = this.boxes[k];
          const hb = bx.hb;
          const g = hb.group ?? bx.idx;
          const last = a.hitReg[g * nF + v.id];
          if (last >= 0 && !(hb.multiHitInterval !== undefined && hb.multiHitInterval > 0 && mf - last >= hb.multiHitInterval)) continue;
          const hit =
            hb.shape === 'circle'
              ? circleRect(bx.cx, bx.cy, hb.r, rx0, ry0, rx1, ry1)
              : rectRect(bx.cx, bx.cy, hb.w, hb.h, rx0, ry0, rx1, ry1);
          if (!hit) continue;
          nHit++;
          const sweet = this.sweetInside(a, bx, v);
          const dmg = hb.damage * (sweet && hb.sweet ? hb.sweet.damageMult : 1);
          if (dmg > bestDmg) {
            bestDmg = dmg;
            best = k;
          }
          bx.hit = true;
        }
        if (nHit === 0) continue;
        for (let k = 0; k < this.boxes.length; k++) {
          const bx = this.boxes[k];
          if (!bx.hit) continue;
          bx.hit = false;
          a.hitReg[(bx.hb.group ?? bx.idx) * nF + v.id] = mf;
        }
        const bx = this.boxes[best];
        this.pending.push({ a, v, moveId: a.moveId, hb: bx.hb, cx: bx.cx, cy: bx.cy, sweet: this.sweetInside(a, bx, v) });
      }
    }
    for (let i = 0; i < this.pending.length; i++) this.applyHit(this.pending[i]);
    if (this.platPending.length > 0) this.applyPlatformHits();
  }

  /**
   * v1.6: count this attacker's active hitboxes against the breakable platforms (see the header). Counting is attack based: it needs no
   * victim, ignores hitlag / armor / invulnerability, and is limited to one count per activation and platform and to one per
   * PHYS.platHitCooldown frames per attacker and platform.
   */
  private collectPlatformHits(a: Fighter): void {
    const pad = PHYS.platHitPad;
    for (let n = 0; n < this.breakIdx.length; n++) {
      const j = this.breakIdx[n];
      const p = this.plat[j];
      if (!p.active || p.hp <= 0) continue;
      if (a.platAct[j] === a.actSerial) continue;
      if (this.frameNo - a.platFrame[j] < PHYS.platHitCooldown) continue;
      const rx0 = p.x0 - pad;
      const rx1 = p.x1 + pad;
      const ry0 = p.y - p.thickness - pad;
      const ry1 = p.y + pad;
      for (let k = 0; k < this.boxes.length; k++) {
        const bx = this.boxes[k];
        const hb = bx.hb;
        if (!(hb.damage > 0)) continue;
        const hit =
          hb.shape === 'circle' ? circleRect(bx.cx, bx.cy, hb.r, rx0, ry0, rx1, ry1) : rectRect(bx.cx, bx.cy, hb.w, hb.h, rx0, ry0, rx1, ry1);
        if (!hit) continue;
        a.platAct[j] = a.actSerial;
        a.platFrame[j] = this.frameNo;
        this.platPending.push({ j, attackerId: a.id, x: clampNum(bx.cx, p.x0, p.x1), y: clampNum(bx.cy, p.y - p.thickness, p.y) });
        break;
      }
    }
  }

  /** Apply the frame's counted platform hits in attacker order; a platform that reaches 0 breaks, the last one flips the stage to its final form. */
  private applyPlatformHits(): void {
    let broke = false;
    for (let i = 0; i < this.platPending.length; i++) {
      const ph = this.platPending[i];
      const p = this.plat[ph.j];
      if (!p.active || p.hp <= 0) continue; // already destroyed earlier this frame
      p.hp--;
      this.emit({ type: 'platformHit', platformId: p.id, attackerId: ph.attackerId, hpLeft: p.hp, maxHp: p.maxHp, pos: { x: ph.x, y: ph.y } });
      if (p.hp <= 0) {
        this.breakPlatform(ph.j);
        broke = true;
      }
    }
    if (broke && !this.finalForm) {
      for (let n = 0; n < this.breakIdx.length; n++) if (this.plat[this.breakIdx[n]].active) return;
      this.enterFinalForm();
    }
  }

  /** A breakable platform is destroyed: it stops colliding NOW; whoever stood on / hung from it falls. */
  private breakPlatform(j: number): void {
    const p = this.plat[j];
    p.active = false;
    p.hp = 0;
    this.emit({
      type: 'platformBreak',
      platformId: p.id,
      pos: { x: (p.x0 + p.x1) * 0.5, y: p.y - p.thickness * 0.5 },
      x0: p.x0,
      x1: p.x1,
      y: p.y,
    });
    for (let i = 0; i < this.fighters.length; i++) {
      const f = this.fighters[i];
      if (!f.alive) continue;
      if (f.ledgeIdx >= 0 && this.ledges[f.ledgeIdx].plat === j) {
        this.dropFromLedge(f);
        continue;
      }
      if (f.grounded && f.platIdx === j) {
        this.leaveGround(f);
        f.vel.y = 0;
        if (f.action === 'jumpSquat') this.setStable(f, 'fall');
      }
    }
  }

  /** Every breakable is gone: the `finalOnly` platforms appear (fighters embedded in a new solid are pushed out of it). */
  private enterFinalForm(): void {
    this.finalForm = true;
    for (let j = 0; j < this.plat.length; j++) {
      if (this.defs[j].finalOnly) this.plat[j].active = true;
    }
    this.emit({ type: 'stageFinal' });
    for (let j = 0; j < this.plat.length; j++) {
      const p = this.plat[j];
      if (!this.defs[j].finalOnly || !p.solid) continue;
      for (let i = 0; i < this.fighters.length; i++) this.pushOut(this.fighters[i], j, false);
    }
  }

  private sweetInside(a: Fighter, bx: ActiveBox, v: Fighter): boolean {
    const s = bx.hb.sweet;
    if (!s) return false;
    const sx = a.pos.x + a.facing * (s.x + bx.px);
    const sy = a.pos.y + s.y + bx.py;
    const vx = v.pos.x;
    const vy = (v.pos.y + this.hurtTop(v)) * 0.5;
    const dx = vx - sx;
    const dy = vy - sy;
    return dx * dx + dy * dy <= s.r * s.r;
  }

  private applyHit(h: PendingHit): void {
    const { a, v, hb } = h;
    if (!v.alive || this.isInvulnerable(v)) return;
    const stale = staleMultiplier(a.staleQueue, h.moveId);
    const calc = computeHit(hb, h.sweet, stale, v.percent, v.stats.weight, a.facing);
    // contact point for events
    const hx = v.stats.width * 0.5;
    const pos = { x: clampNum(h.cx, v.pos.x - hx, v.pos.x + hx), y: clampNum(h.cy, v.pos.y, this.hurtTop(v)) };
    a.moveConnected = true;
    if (!a.movePushed) {
      a.movePushed = true;
      a.staleQueue.push(h.moveId);
      if (a.staleQueue.length > PHYS.staleQueue) a.staleQueue.shift();
    }
    v.lastHitBy = a.id;
    v.lastHitFrame = this.frameNo;

    // armor: absorb (damage × scale), no knockback / hitstun
    if (this.armorActive(v)) {
      const scale = v.body?.armor?.dmgScale ?? PHYS.armorDmgScale;
      const dmg = calc.dmg * scale;
      v.armorLeft--;
      v.percent = Math.min(PHYS.percentCap, v.percent + dmg);
      a.damageDealt += dmg;
      a.hitlag = Math.max(a.hitlag, calc.hitlag);
      v.hitlag = Math.max(v.hitlag, calc.hitlag);
      this.emit({
        type: 'hit',
        attackerId: a.id,
        targetId: v.id,
        moveId: h.moveId,
        damage: dmg,
        percentAfter: v.percent,
        kbSpeed: 0,
        angle: calc.angle,
        pos,
        sweetspot: h.sweet && !!hb.sweet,
        hitlag: calc.hitlag,
      });
      return;
    }

    a.damageDealt += calc.dmg;
    v.percent = calc.pctAfter;
    let vx = calc.vx;
    let vy = calc.vy;
    let hitstun = calc.hitstun;
    let tumble = calc.tumble;
    const fx = hb.effect;
    let buried = false;

    if (v.grounded) {
      if (vy < 0) vy = -vy * PHYS.bounceKeep;
    }
    if (fx === 'pull') {
      const dir = a.pos.x === v.pos.x ? a.facing : sgn(a.pos.x - v.pos.x);
      vx = dir * Math.min(calc.kb, PHYS.pullSpeedMax);
      vy = v.grounded ? 0 : vy * 0.2;
      tumble = false;
    } else if (fx === 'stun') {
      hitstun += PHYS.stunBonusFrames;
      tumble = false;
    } else if (fx === 'flinch') {
      hitstun = Math.min(hitstun, PHYS.flinchHitstunMax);
      tumble = false;
    } else if (fx === 'bury' && v.grounded && calc.kb <= PHYS.buryKbMax) {
      buried = true;
    }

    // interrupt whatever the victim was doing
    this.releaseLedge(v);
    v.body = null;
    v.moveId = null;
    v.moveChain = 0;
    v.moveAir = false;
    v.moveFrame = 0;
    v.moveFrames = 0;
    v.movePhase = null;
    v.armorLeft = 0;
    v.freeFall = false;
    v.fastFalling = false;
    v.recoveryUsed = false;
    v.hopWindow = 0;
    v.dropTimer = 0;
    v.diUsed = 0;
    v.pendingTumble = false;
    v.lastLaunch = { angle: calc.angle, speed: calc.kb };

    if (buried) {
      v.vel.x = 0;
      v.vel.y = 0;
      v.hitstun = 0;
      v.hitstunTotal = PHYS.buryFrames;
      this.setAction(v, 'knockdown', PHYS.buryFrames);
    } else {
      v.vel.x = vx;
      v.vel.y = vy;
      if (v.grounded && Math.abs(vy) < PHYS.slideVy && vy <= 0.5) {
        v.vel.y = 0; // slide along the floor
      } else if (v.grounded) {
        this.leaveGround(v);
      }
      v.hitstun = hitstun;
      v.hitstunTotal = hitstun;
      this.setAction(v, 'hitstun', hitstun);
      v.pendingTumble = tumble;
    }
    v.hitlag = Math.max(v.hitlag, calc.hitlag);
    a.hitlag = Math.max(a.hitlag, calc.hitlag);

    this.emit({
      type: 'hit',
      attackerId: a.id,
      targetId: v.id,
      moveId: h.moveId,
      damage: calc.dmg,
      percentAfter: v.percent,
      kbSpeed: calc.kb,
      angle: calc.angle,
      pos,
      sweetspot: h.sweet && !!hb.sweet,
      hitlag: calc.hitlag,
    });
  }

  // ── KO, blast zones, match end ───────────────────────────────────────────

  private checkBlast(): void {
    const b = this.stage.blast;
    for (const f of this.fighters) {
      if (!f.alive) continue;
      const x = f.pos.x;
      const y = f.pos.y;
      let side: 'left' | 'right' | 'top' | 'bottom' | null = null;
      let worst = 0;
      if (x < b.left && b.left - x > worst) {
        worst = b.left - x;
        side = 'left';
      }
      if (x > b.right && x - b.right > worst) {
        worst = x - b.right;
        side = 'right';
      }
      if (y > b.top && y - b.top > worst) {
        worst = y - b.top;
        side = 'top';
      }
      if (y < b.bottom && b.bottom - y > worst) {
        worst = b.bottom - y;
        side = 'bottom';
      }
      if (side) this.koFighter(f, side);
    }
  }

  private koFighter(f: Fighter, side: 'left' | 'right' | 'top' | 'bottom'): void {
    const b = this.stage.blast;
    const credited = f.lastHitBy >= 0 && f.lastHitBy !== f.id && this.frameNo - f.lastHitFrame <= PHYS.koCreditFrames;
    const killerId = credited ? f.lastHitBy : -1;
    if (credited) this.fighters[killerId].kos++;
    this.releaseLedge(f);
    f.stocks = Math.max(0, f.stocks - 1);
    f.falls++;
    f.alive = false;
    f.percent = 0;
    f.pos.x = clampNum(f.pos.x, b.left, b.right);
    f.pos.y = clampNum(f.pos.y, b.bottom, b.top);
    f.vel.x = 0;
    f.vel.y = 0;
    f.grounded = false;
    f.platIdx = -1;
    f.hitstun = 0;
    f.hitlag = 0;
    f.invuln = 0;
    f.body = null;
    f.moveId = null;
    f.moveChain = 0;
    f.moveFrame = 0;
    f.moveFrames = 0;
    f.movePhase = null;
    f.pendingTumble = false;
    this.setAction(f, 'ko', 0);
    f.respawnIn = f.stocks > 0 ? PHYS.koOutFrames : 0;
    this.emit({ type: 'ko', fighterId: f.id, killerId, side, pos: { x: f.pos.x, y: f.pos.y }, stocksLeft: f.stocks });
  }

  private checkMatchEnd(): void {
    let withStocks = 0;
    let last = -1;
    for (const f of this.fighters) {
      if (f.stocks > 0) {
        withStocks++;
        last = f.id;
      }
    }
    const solo = this.fighters.length < 2;
    if (solo ? withStocks === 0 : withStocks <= 1) {
      this.finish(withStocks === 1 ? last : -1);
      return;
    }
    if (this.timeLimitFrames > 0 && this.frameNo - PHYS.countdownFrames >= this.timeLimitFrames) {
      let top = -1;
      for (const f of this.fighters) if (f.stocks > top) top = f.stocks;
      let low = Infinity;
      let winner = -1;
      let tie = false;
      for (const f of this.fighters) {
        if (f.stocks !== top) continue;
        if (f.percent < low) {
          low = f.percent;
          winner = f.id;
          tie = false;
        } else if (f.percent === low) {
          tie = true;
        }
      }
      this.finish(tie ? -1 : winner);
    }
  }

  private finish(winnerId: number): void {
    this.over = true;
    this.winner = winnerId;
    this.emit({ type: 'matchEnd', winnerId });
  }

  /** Internal fighter lookup for white-box tests (read-only use). */
  debugFighter(id: number): Fighter {
    return this.fighters[id];
  }
}
