/**
 * Champions League bot (plan §7). `new BrawlBot(selfId, difficulty, seed)` implements `BrawlBotApi`:
 * one call per sim frame with the latest snapshot, one `BrawlIntent` back. No cheating — the bot reads
 * only the snapshot:
 *   - itself from the LATEST snapshot (a player feels their own character instantly),
 *   - opponents through a reaction-delay queue (24–32 frames at level 1 … 4–6 at level 4),
 *   - move/stage knowledge from the public data (frame data, reach, launch, platforms) like a veteran.
 * All randomness goes through a seeded mulberry32, so the output is a pure function of (snapshot stream, seed).
 *
 * Structure: perception (`sense`) → state dispatch (`think`) → handlers: ground neutral / air /
 * attacking (string links) / hitstun (DI) / ledge options / respawn / recovery planner. The attack
 * engine scores every move of the animal against the opponent's (extrapolated) hurtbox using the move
 * hitboxes frame by frame, weighing certainty (is the opponent committed?), damage, kill chance
 * (a launch simulation) and whiff risk (endlag).
 */

import { mulberry32 } from '../../core/math';
import type { Rng } from '../../core/math';
import type { AnimalId } from '../../core/types';
import type {
  BrawlAction,
  BrawlBotApi,
  BrawlDifficulty,
  BrawlFighterState,
  BrawlIntent,
  BrawlSnapshot,
  CharacterStats,
  HitboxDef,
  MoveBody,
  MoveId,
} from '../types';
import { MOVESETS, getMoveBody } from '../data';
import { LEVELS, TACTICS } from './profiles';
import type { AnimalTactics, LevelParams } from './profiles';
import { animalInfo, moveInfo, probeHit, probeRect } from './moveInfo';
import type { AnimalInfo, MoveInfo } from './moveInfo';
import { StageInfo, stageFromSnapshot, supportedBy } from './stageInfo';
import type { Plat } from './stageInfo';
import { PHYS } from '../config';
import { flight, ledgeSpot, simRecovery, steerTo } from './kinematics';
import type { RecEnv, RecPolicy, RecState } from './kinematics';

const GRAV = 38;
const NEG_INF = -1e9;

// ── small helpers ────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const sgn = (v: number): 1 | -1 => (v < 0 ? -1 : 1);

const GROUND_IDS: readonly MoveId[] = ['lightN', 'lightS', 'lightD', 'lightU', 'heavyN', 'heavyS', 'heavyD', 'heavyU'];
const AIR_IDS: readonly MoveId[] = ['lightN', 'lightS', 'lightD', 'lightU', 'heavyN', 'heavyS', 'heavyD'];

/** Everything the bot perceives about one opponent (from the delayed snapshot, extrapolated for levels 3+). */
interface Opp {
  s: BrawlFighterState;
  st: CharacterStats;
  ai: AnimalInfo;
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  dx: number;
  dy: number;
  dist: number;
  /** Frames until it can act (0 = actionable now). */
  free: number;
  invuln: number;
  grounded: boolean;
  offstage: boolean;
  hanging: boolean;
}

interface Cand {
  id: MoveId;
  air: boolean;
  /** Stick direction to press with (−1/1 side attacks turn toward it). */
  dir: 1 | -1;
  score: number;
  frame: number;
  kill: boolean;
}

interface RecPlan {
  tx: number;
  jumpY: number;
  heavyY: number;
  heavyLast: boolean;
  glide: boolean;
  kind: 'ledge' | 'land' | 'fallback';
  ledge: number;
  at: number;
}

interface Threat {
  o: Opp;
  info: MoveInfo;
  /** The attacker's move frame now (delay-adjusted). */
  mf0: number;
  /** Steps until the first / last hit frame lands on us if we stand still. */
  tFirst: number;
  tLast: number;
  dmg: number;
}

interface RecTgt {
  kind: 'ledge' | 'land';
  tx: number;
  ty: number;
  ledge: number;
  /** Platform index the target belongs to. */
  plat: number;
  d: number;
}

interface RecWin {
  t: RecTgt;
  pol: RecPolicy;
  frames: number;
}

interface SmashPlan {
  /** Platform index of the piece to break. */
  plat: number;
  /** hp of the piece when planned (a change means someone hit it: re-plan). */
  hp: number;
  /** Where to stand, which move, which way to face. */
  x: number;
  /** null = go stand on the piece first (soft pieces). */
  id: MoveId | null;
  dir: 1 | -1;
  until: number;
  /** Cannot stand on it: jump under it and hit it from below. */
  jab?: boolean;
}

/** One verified step of the platform graph: leave run A from `launchX` and land on run B (v1.6 dynamic stages). */
interface HopEdge {
  /** Representative platform index of the target run (the member under `tx`). */
  to: number;
  launchX: number;
  dir: 1 | -1;
  kind: 'jump' | 'drop' | 'walk';
  /** Where to steer in the air and the air-jump height rule of the verified policy. */
  tx: number;
  jumpY: number;
}

interface LedgePlan {
  opt: 'climb' | 'jump' | 'roll' | 'drop';
  at: number;
}

export class BrawlBot implements BrawlBotApi {
  /** Debug tooling only: when true the bot keeps a one-line explanation of its last decision in `why`. */
  static DEBUG = false;
  why = '';
  readonly selfId: number;
  readonly difficulty: BrawlDifficulty;
  /** What the bot is currently doing (debug / TRACE only). */
  mode = 'init';

  private readonly lp: LevelParams;
  private readonly rng: Rng;
  private readonly hist: BrawlSnapshot[] = [];
  private stage: StageInfo | null = null;
  private animal: AnimalId | null = null;
  private tac: AnimalTactics = TACTICS.lion;
  private ai: AnimalInfo = animalInfo('lion');
  private stats: CharacterStats = MOVESETS.lion.stats;
  private recBody: MoveBody = getMoveBody('lion', 'heavyU', true);
  private recEnv: RecEnv | null = null;

  // output state (stick persists between decision ticks; edges fire once)
  private readonly cur: BrawlIntent = { moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false };
  private jumpHoldUntil = -1;
  private afterPress = false;

  // perception
  private delay = 8;
  private delayRedrawAt = 0;
  private delayUsed = 0;
  private opps: Opp[] = [];
  private nOpps = 0;
  private target = -1;

  // memory
  private nextThink = 0;
  private prevAction: BrawlAction = 'idle';
  private prevMoveKey = '';
  private connected = false;
  private lastExchange = 0;
  private prevPercent = 0;
  private prevStocks = -1;
  private plan: RecPlan | null = null;
  private ledgePlan: LedgePlan | null = null;
  private diSign: -1 | 0 | 1 = 0;
  private diKey = -1;
  private respawnWait = 60;
  private punishFor = new Map<number, boolean>();
  private threatSeen = new Map<number, number>();
  private threatDodge = new Map<number, boolean>();
  private mashAt = 0;
  private wanderDir: 1 | -1 = 1;
  private wanderUntil = 0;
  private lastThinkFrame = -1;
  /** Platform index of the island a gap crossing is aimed at (−1 = none) and until when. */
  private crossGoal = -1;
  private preferLandUntil = 0;
  private crossUntil = 0;
  // stall tracking: the frame since which the bot has been calm and standing still (platform-relative, ±0.5 m)
  private stillSince = 0;
  private stillAnchor = 0;
  private stillPlat = '';
  // v1.6 breakables: demolition plan (hit a nearby piece in downtime), appetite drawn once per match on stages that have breakables
  // v1.6 platform graph: walkable runs (touching platforms at one height), verified hops between them, the hop in flight
  private runOf: number[] = [];
  private runLo: number[] = [];
  private runHi: number[] = [];
  private runY: number[] = [];
  private runN = 0;
  private readonly hopCache = new Map<number, HopEdge | null>();
  private hopStamp = -1;
  private hopTx = NaN;
  private hopJumpY = NEG_INF;
  private hopUntil = 0;
  private anySig = 0;
  private lastAny = 0;
  private diveUntil = 0;
  private diveDir: 1 | -1 = 1;
  private jabPlat = -1;
  private jabUntil = 0;
  private relocUntil = 0;
  private relocTx = 0;
  private relocCool = 0;
  private hopCommitUntil = 0;
  private hopCommitX = 0;
  private hopCommitY = 0;
  private boredTx = NaN;
  private boredUntil = 0;
  private smashAppetite = 0;
  private smashNext = 0;
  private smashPlan: SmashPlan | null = null;
  private readonly span = { lo: 0, hi: 0 };

  constructor(selfId: number, difficulty: BrawlDifficulty, seed: number) {
    this.selfId = selfId;
    this.difficulty = difficulty;
    this.lp = LEVELS[difficulty];
    this.rng = mulberry32((seed ^ (selfId * 0x9e3779b1) ^ (difficulty * 0x85ebca6b)) >>> 0);
    this.delay = this.drawDelay();
  }

  private drawDelay(): number {
    const [lo, hi] = this.lp.delay;
    return lo + Math.floor(this.rng() * (hi - lo + 1));
  }

  // ── public ──────────────────────────────────────────────────────────────

  update(snap: BrawlSnapshot): BrawlIntent {
    this.hist.push(snap);
    if (this.hist.length > 40) this.hist.shift();
    if (!this.stage) this.init(snap);
    const stage = this.stage as StageInfo;
    stage.sync(snap.platforms, snap.frame);
    const me = snap.fighters[this.selfId];
    const c = this.cur;
    if (this.afterPress) {
      c.moveX = 0;
      c.moveY = 0;
      this.afterPress = false;
    }
    if (!me || !me.alive || snap.matchOver || snap.countdown > 0) {
      this.resetMemory();
      c.moveX = 0;
      c.moveY = 0;
      c.jumpHeld = false;
      this.mode = 'idle';
      return this.emit();
    }
    this.trackExchange(snap, me);
    this.trackStill(snap, me);
    // reaction delay jitters a little over time
    if (snap.frame >= this.delayRedrawAt) {
      this.delay = this.drawDelay();
      this.delayRedrawAt = snap.frame + 90 + Math.floor(this.rng() * 120);
    }
    const moveKey = me.action === 'attack' ? `${me.moveId}:${me.moveChain}:${me.moveAir ? 1 : 0}` : '';
    if (moveKey !== this.prevMoveKey) {
      if (moveKey !== '') this.connected = false;
      this.prevMoveKey = moveKey;
    }
    if (me.action === 'attack' && me.hitlag > 0) this.connected = true;
    const changed = me.action !== this.prevAction;
    this.prevAction = me.action;
    if (this.jumpHoldUntil < snap.frame && !this.wantGlide()) c.jumpHeld = false;
    if (changed || snap.frame >= this.nextThink || me.action === 'attack' || me.action === 'hitstun' || me.action === 'tumble') {
      this.think(me, snap);
      this.lastThinkFrame = snap.frame;
      this.nextThink = snap.frame + this.thinkInterval(me);
    }
    return this.emit();
  }

  // ── bookkeeping ─────────────────────────────────────────────────────────

  private init(snap: BrawlSnapshot): void {
    this.stage = stageFromSnapshot(snap);
    if (this.stage.hasBreakables) {
      // how much of its downtime this bot spends smashing the ruins (drawn only on breakable stages: the other stages keep their rng stream)
      const base = this.lp.level >= 4 ? 0.85 : this.lp.level === 3 ? 0.75 : this.lp.level === 2 ? 0.4 : 0;
      this.smashAppetite = base * (0.75 + this.rng() * 0.5);
    }
    const me = snap.fighters[this.selfId];
    if (me) {
      this.animal = me.animal;
      this.tac = TACTICS[me.animal];
      this.ai = animalInfo(me.animal);
      this.stats = MOVESETS[me.animal].stats;
      this.recBody = getMoveBody(me.animal, 'heavyU', true);
      this.recEnv = {
        stage: this.stage,
        stats: this.stats,
        rec: this.recBody,
        freeLedge: (i) => this.ledgeFree(i),
      };
    }
  }

  private resetMemory(): void {
    this.plan = null;
    this.ledgePlan = null;
    this.diveUntil = 0;
    this.diKey = -1;
    this.diSign = 0;
    this.connected = false;
    this.cur.jump = this.cur.light = this.cur.heavy = this.cur.dodge = false;
    this.respawnWait = this.waitFrames();
  }

  private waitFrames(): number {
    switch (this.lp.level) {
      case 1:
        return 110 + Math.floor(this.rng() * 70);
      case 2:
        return 70 + Math.floor(this.rng() * 60);
      case 3:
        return 50 + Math.floor(this.rng() * 40);
      default:
        return 42 + Math.floor(this.rng() * 30);
    }
  }

  private emit(): BrawlIntent {
    const c = this.cur;
    const out: BrawlIntent = {
      moveX: Number.isFinite(c.moveX) ? clamp(c.moveX, -1, 1) : 0,
      moveY: Number.isFinite(c.moveY) ? clamp(c.moveY, -1, 1) : 0,
      jump: c.jump,
      jumpHeld: c.jumpHeld,
      light: c.light,
      heavy: c.heavy,
      dodge: c.dodge,
    };
    if (c.jump || c.light || c.heavy || c.dodge) {
      this.afterPress = true;
    }
    c.jump = c.light = c.heavy = c.dodge = false;
    return out;
  }

  private thinkInterval(me: BrawlFighterState): number {
    const base = this.lp.think;
    if (base <= 1) {
      // far away and calm: think less often
      if (this.nOpps > 0 && me.grounded && me.action !== 'attack') {
        const t = this.opps[0];
        if (t && t.dist > 9 && t.free === 0) return 3;
      }
      return 1;
    }
    return base;
  }

  /** Calm + standing still on the same spot of its platform (±0.5 m): the stall breaker reads `stillFrames`. */
  private trackStill(snap: BrawlSnapshot, me: BrawlFighterState): void {
    const calm = me.grounded && me.platformId !== null && (me.action === 'idle' || me.action === 'walk' || me.action === 'run' || me.action === 'crouch');
    const stage = this.stage as StageInfo;
    const pi = calm ? stage.platIndex(me.platformId) : -1;
    if (pi < 0) {
      this.stillSince = snap.frame;
      this.stillPlat = '';
      return;
    }
    const p = stage.plats[pi];
    const rel = me.pos.x - (p.x0 + p.x1) * 0.5;
    if (this.stillPlat !== me.platformId || Math.abs(rel - this.stillAnchor) > 0.5) {
      this.stillPlat = me.platformId as string;
      this.stillAnchor = rel;
      this.stillSince = snap.frame;
    }
  }

  /** Stall-breaker pressure 0..1: grows with the time since the last damage exchange (900 f) and with the time spent standing still (100-240 f). */
  private pressureNow(snap: BrawlSnapshot): number {
    const ex = clamp((snap.frame - this.lastExchange) / 900, 0, 1);
    const still = clamp((snap.frame - this.stillSince - 100) / 140, 0, 1);
    return ex > still ? ex : still;
  }

  private trackExchange(snap: BrawlSnapshot, me: BrawlFighterState): void {
    // anybody's damage or stock change (for the stalemate dive; `lastExchange` keeps the older "my own" meaning)
    let sig = me.percent + me.stocks * 1000;
    for (const f of snap.fighters) if (f.id !== this.selfId) sig += f.percent * 1.37 + f.stocks * 777;
    if (sig !== this.anySig) {
      this.anySig = sig;
      this.lastAny = snap.frame;
    }
    if (me.percent !== this.prevPercent || me.stocks !== this.prevStocks) {
      this.lastExchange = snap.frame;
      this.prevPercent = me.percent;
      this.prevStocks = me.stocks;
    }
  }

  private wantGlide(): boolean {
    return this.stats.glideFall !== undefined && this.plan !== null && this.plan.glide;
  }

  // ── perception ──────────────────────────────────────────────────────────

  private view(): BrawlSnapshot {
    const n = this.hist.length;
    const d = Math.min(this.delay, n - 1);
    this.delayUsed = d;
    return this.hist[n - 1 - d];
  }

  private ledgeFree(i: number): boolean {
    const stage = this.stage as StageInfo;
    const L = stage.ledges[i];
    if (!L.open) return false;
    const p = stage.plats[L.plat];
    for (let k = 0; k < this.nOpps; k++) {
      const o = this.opps[k];
      if (!o.hanging && o.s.action !== 'ledgeClimb') continue;
      if (Math.abs(o.s.pos.x - L.x) < 1.6 && Math.abs(o.s.pos.y - p.y) < 3) return false;
    }
    return true;
  }

  private sense(me: BrawlFighterState): void {
    const view = this.view();
    const stage = this.stage as StageInfo;
    const lp = this.lp;
    const D = this.delayUsed;
    let n = 0;
    for (const s of view.fighters) {
      if (s.id === this.selfId || !s.alive) continue;
      let o = this.opps[n];
      if (!o) {
        o = {
          s,
          st: MOVESETS[s.animal].stats,
          ai: animalInfo(s.animal),
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          w: 1,
          h: 1,
          dx: 0,
          dy: 0,
          dist: 0,
          free: 0,
          invuln: 0,
          grounded: false,
          offstage: false,
          hanging: false,
        };
        this.opps[n] = o;
      }
      n++;
      o.s = s;
      if (o.st.width !== MOVESETS[s.animal].stats.width || o.st !== MOVESETS[s.animal].stats) {
        o.st = MOVESETS[s.animal].stats;
        o.ai = animalInfo(s.animal);
      }
      const st = o.st;
      let x = s.pos.x;
      let y = s.pos.y;
      let vx = s.vel.x;
      let vy = s.vel.y;
      if (lp.extrap && D > 0) {
        const t = D / 60;
        const inHit = s.action === 'hitstun' || s.action === 'tumble';
        if (s.grounded) {
          x += vx * t * 0.6;
        } else if (s.action !== 'ledgeHang' && s.action !== 'respawn' && s.action !== 'ledgeClimb') {
          const g = GRAV * st.gravityMult * (inHit ? 0.85 : 1);
          x += vx * t * 0.97;
          y += vy * t - 0.5 * g * t * t;
          vy -= g * t;
          const fl = stage.platformBelow(s.pos.x, s.pos.y, st.width, 0.05);
          if (fl >= 0 && y < stage.plats[fl].y) {
            y = stage.plats[fl].y;
            vy = 0;
          }
        }
      }
      o.x = x;
      o.y = y;
      o.vx = vx;
      o.vy = vy;
      o.w = st.width;
      o.h = s.action === 'crouch' ? st.height * 0.6 : st.height;
      o.dx = x - me.pos.x;
      o.dy = y - me.pos.y;
      o.dist = Math.abs(o.dx);
      o.grounded = s.grounded;
      o.hanging = s.action === 'ledgeHang';
      o.invuln = s.invuln;
      // v1.6: a burrowed fighter cannot be hit until it surfaces — count the remaining underground frames as invulnerability
      if (s.underground === true && s.moveId) {
        const bw = moveInfo(s.animal, s.moveId, s.moveAir, s.moveChain).burrow;
        if (bw) o.invuln = Math.max(o.invuln, bw.to - s.moveFrame);
      }
      // frames until it can act
      let free = 0;
      switch (s.action) {
        case 'attack':
          free = s.moveFrames - s.moveFrame;
          break;
        case 'hitstun':
        case 'tumble':
          free = s.hitstun;
          break;
        case 'landing':
        case 'dodgeSpot':
        case 'dodgeRoll':
        case 'dodgeAir':
        case 'getup':
        case 'knockdown':
        case 'ledgeClimb':
        case 'jumpSquat':
          free = Math.max(0, s.actionFrames - s.actionFrame);
          break;
        default:
          free = 0;
      }
      if (s.action === 'knockdown') free += 14;
      if (s.hitlag > 0) free += s.hitlag;
      if (s.action === 'dodgeSpot' || s.action === 'dodgeRoll' || s.action === 'dodgeAir') o.invuln = Math.max(o.invuln, 0);
      if (lp.adjust) {
        free = Math.max(0, free - D);
        o.invuln = Math.max(0, o.invuln - D);
      }
      o.free = free;
      o.offstage = !s.grounded && !o.hanging && s.action !== 'respawn' && stage.platformBelow(x, y, st.width, 0.3) < 0;
    }
    this.nOpps = n;
    // nearest first (cheap insertion sort by horizontal+vertical distance)
    for (let i = 1; i < n; i++) {
      const o = this.opps[i];
      const k = o.dist + Math.abs(o.dy) * 0.4;
      let j = i - 1;
      while (j >= 0 && this.opps[j].dist + Math.abs(this.opps[j].dy) * 0.4 > k) {
        this.opps[j + 1] = this.opps[j];
        j--;
      }
      this.opps[j + 1] = o;
    }
  }

  /** Current chosen target (hysteresis so FFA bots do not flip between foes every frame). */
  private pickTarget(): Opp | null {
    if (this.nOpps === 0) return null;
    let best = this.opps[0];
    if (this.target >= 0) {
      for (let i = 0; i < this.nOpps; i++) {
        if (this.opps[i].s.id === this.target) {
          if (this.opps[i].dist + Math.abs(this.opps[i].dy) * 0.4 < best.dist + Math.abs(best.dy) * 0.4 + 3.5) best = this.opps[i];
          break;
        }
      }
    }
    this.target = best.s.id;
    return best;
  }

  // ── decision dispatch ───────────────────────────────────────────────────

  private think(me: BrawlFighterState, snap: BrawlSnapshot): void {
    this.sense(me);
    switch (me.action) {
      case 'respawn':
        this.doRespawn(me);
        return;
      case 'ledgeHang':
        this.doLedge(me);
        return;
      case 'hitstun':
      case 'tumble':
        this.doHitstun(me);
        return;
      case 'attack':
        this.doAttacking(me);
        return;
      case 'ko':
      case 'ledgeClimb':
      case 'knockdown':
      case 'getup':
      case 'dodgeSpot':
      case 'dodgeAir':
      case 'landing':
        this.cur.moveX = 0;
        this.cur.moveY = 0;
        this.mode = me.action;
        return;
      case 'dodgeRoll':
      case 'jumpSquat':
        this.mode = me.action;
        return;
      default:
        break;
    }
    // free actions
    if (me.grounded) this.doGround(me, snap);
    else if (me.freeFall) {
      this.mode = 'freefall';
      this.steerRecovery(me);
    } else if (this.needsRecovery(me)) this.doRecover(me, snap);
    else this.doAir(me, snap);
  }

  private needsRecovery(me: BrawlFighterState): boolean {
    const stage = this.stage as StageInfo;
    return stage.platformBelow(me.pos.x, me.pos.y, this.stats.width, 0.3) < 0;
  }

  // ── inputs ──────────────────────────────────────────────────────────────

  private press(kind: 'light' | 'heavy', mx: number, my: number): void {
    const c = this.cur;
    c.moveX = mx;
    c.moveY = my;
    if (kind === 'light') c.light = true;
    else c.heavy = true;
  }

  private doJump(frame: number, mx: number, short = false): void {
    const c = this.cur;
    c.jump = true;
    c.moveX = mx;
    c.jumpHeld = true;
    this.jumpHoldUntil = short ? frame : frame + 14;
  }

  // ── respawn ─────────────────────────────────────────────────────────────

  private doRespawn(me: BrawlFighterState): void {
    const c = this.cur;
    this.mode = 'respawn';
    if (me.actionFrame < this.respawnWait) {
      c.moveX = 0;
      c.moveY = 0;
      return;
    }
    const stage = this.stage as StageInfo;
    if (stage.dyn) {
      // dynamic stage: drop onto the nearest platform that exists right now (any kind), preferring the solid ones
      let bestD = Infinity;
      let gx = stage.centerX;
      for (const p of stage.plats) {
        if (!p.active || p.y > me.pos.y - 1) continue;
        const cx = clamp(me.pos.x, p.x0 + 0.8, p.x1 - 0.8);
        const d = Math.abs(cx - me.pos.x) + (p.solid ? 0 : 1.2) + (me.pos.y - p.y) * 0.1;
        if (d < bestD) {
          bestD = d;
          gx = p.x1 - p.x0 > 1.6 ? cx : (p.x0 + p.x1) * 0.5;
        }
      }
      c.moveX = Math.abs(gx - me.pos.x) > 0.8 ? sgn(gx - me.pos.x) : 0;
      c.moveY = -1;
      return;
    }
    // drop toward an island/stage the opponents are not standing on
    let tx = stage.centerX;
    if (!stage.overSolid(me.pos.x, -1)) {
      let bestD = Infinity;
      for (const p of stage.plats) {
        if (!p.solid || !p.active) continue;
        const cx = (p.x0 + p.x1) * 0.5;
        const d = Math.abs(cx - me.pos.x) + this.rng() * 4;
        if (d < bestD) {
          bestD = d;
          tx = cx;
        }
      }
    }
    c.moveX = Math.abs(tx - me.pos.x) > 0.8 ? sgn(tx - me.pos.x) : 0;
    c.moveY = -1;
  }

  // ── hitstun / DI ────────────────────────────────────────────────────────

  private doHitstun(me: BrawlFighterState): void {
    const c = this.cur;
    const lp = this.lp;
    this.mode = 'hitstun';
    c.moveX = 0;
    c.moveY = 0;
    if (lp.di === 0 || me.grounded) return;
    const stage = this.stage as StageInfo;
    const sp = Math.hypot(me.vel.x, me.vel.y);
    if (sp < 3) return;
    if (lp.di === 1) {
      // crude: hold toward the stage centre, sometimes forgetting
      if (this.rng() < 0.65) c.moveX = sgn(stage.centerX - me.pos.x);
      return;
    }
    const key = Math.round(me.percent * 10) + me.stocks * 100000;
    if (key !== this.diKey) {
      this.diKey = key;
      let bestScore = -Infinity;
      let bestSign: -1 | 0 | 1 = 0;
      for (const sign of [0, 1, -1] as const) {
        const r = flight(stage, me.pos.x, me.pos.y, me.vel.x, me.vel.y, me.hitstun, this.stats.gravityMult, this.stats.fallSpeed, this.stats.width, sign * 12);
        let score: number;
        if (r.kill) score = -1000 + r.frames * 0.5;
        else if (r.landed) score = 100 + r.margin * 0.1;
        else score = r.margin;
        if (score > bestScore + (sign === 0 ? 0 : 0.05)) {
          bestScore = score;
          bestSign = sign;
        }
      }
      this.diSign = bestSign;
    }
    if (this.diSign !== 0) {
      // perpendicular to the velocity: CCW (+) / CW (−)
      const ux = (-me.vel.y / sp) * this.diSign;
      const uy = (me.vel.x / sp) * this.diSign;
      c.moveX = ux;
      c.moveY = uy;
    }
  }

  // ── own attack in progress ──────────────────────────────────────────────

  private doAttacking(me: BrawlFighterState): void {
    const c = this.cur;
    const lp = this.lp;
    this.mode = 'attacking';
    c.moveX = 0;
    c.moveY = 0;
    if (!me.moveId) return;
    // air drift while attacking / Heavy-Up steering toward the ledge
    if (!me.grounded) {
      if (me.moveId === 'heavyU' && this.plan) c.moveX = steerTo(me.pos.x, me.vel.x, this.plan.tx, this.stats.airSpeed);
      else {
        const t = this.nOpps > 0 ? this.opps[0] : null;
        const stage = this.stage as StageInfo;
        const pi = stage.platformBelow(me.pos.x, me.pos.y, this.stats.width, 0.3);
        if (t && pi >= 0) {
          let mx = clamp(t.dx * 0.5, -0.6, 0.6);
          if (lp.edgeSafe > 0.5) {
            const p = stage.plats[pi];
            // an aerial lasts long: do not let the drift take us past the platform we will land on
            const ahead = me.pos.x + me.vel.x * 0.4 + mx * 1.5;
            if (ahead < p.x0 + 0.5) mx = Math.max(mx, 0.4);
            else if (ahead > p.x1 - 0.5) mx = Math.min(mx, -0.4);
          }
          c.moveX = mx;
        }
      }
    }
    if (me.moveId !== 'lightN' || me.moveAir || this.animal === null) return;
    const info = moveInfo(this.animal, 'lightN', false, me.moveChain);
    const t = this.nOpps > 0 ? this.opps[0] : null;
    for (const cn of info.cancels) {
      if (!cn.into.includes('lightN')) continue;
      if (me.moveFrame < cn.from - 4 || me.moveFrame >= cn.to - 1) continue;
      if (cn.onHitOnly && !this.connected) continue;
      if (me.hitlag > 3) continue;
      if (lp.level === 1) {
        if (this.rng() < 0.4) this.press('light', 0, 0);
        return;
      }
      // continue only while the next link can reach
      const next = moveInfo(this.animal, 'lightN', false, me.moveChain + 1);
      if (t && !this.connected) {
        const relX = (t.x - me.pos.x) * me.facing;
        const pr = probeHit(next, relX, t.y - me.pos.y, t.w, t.h);
        if (pr.frame < 0 && this.rng() > 0.25) return;
      }
      if (this.connected && lp.level >= 2 && this.rng() < 0.07 * (4 - lp.level)) return; // dropped combo
      this.press('light', 0, 0);
      return;
    }
  }

  // ── ledge ───────────────────────────────────────────────────────────────

  private doLedge(me: BrawlFighterState): void {
    const c = this.cur;
    const lp = this.lp;
    this.mode = 'ledge';
    c.moveX = 0;
    c.moveY = 0;
    this.plan = null;
    if (!this.ledgePlan || me.actionFrame <= 2) {
      // fresh grab: choose what to do and when
      const toStage = me.facing;
      let threatened = false;
      for (let i = 0; i < this.nOpps; i++) {
        const o = this.opps[i];
        if (o.offstage || o.s.action === 'ko') continue;
        if ((o.x - me.pos.x) * toStage > -0.5 && o.dist < 3.8 && Math.abs(o.dy) < 3) threatened = true;
      }
      const r = this.rng();
      let opt: LedgePlan['opt'];
      const st = this.stats;
      const hop = (st.jumpVel * st.jumpVel) / (2 * GRAV * st.gravityMult);
      const goodJump = hop >= 2.3;
      if (lp.level >= 3 && !goodJump) opt = threatened ? (r < 0.5 ? 'roll' : 'climb') : r < 0.65 ? 'climb' : 'roll';
      else if (lp.level === 1) opt = r < 0.5 ? 'climb' : r < 0.8 ? 'jump' : 'drop';
      else if (lp.level === 2) opt = r < 0.7 ? 'climb' : 'jump';
      else if (lp.level === 3) opt = r < 0.55 ? 'climb' : r < 0.85 ? 'jump' : 'roll';
      else if (threatened) opt = r < 0.1 ? 'climb' : r < 0.55 ? 'roll' : 'jump';
      else opt = r < 0.4 ? 'climb' : r < 0.8 ? 'jump' : 'roll';
      let at: number;
      if (lp.level === 1) at = 25 + Math.floor(this.rng() * 70);
      else if (lp.level === 2) at = 18 + Math.floor(this.rng() * 40);
      else at = Math.max(7, me.actionFrame + me.invuln - 3);
      if (threatened && lp.level >= 3 && me.invuln > 12) at = Math.max(7, at - 6);
      this.ledgePlan = { opt, at };
    }
    const lpn = this.ledgePlan;
    if (me.actionFrame < lpn.at || me.actionFrame < 7) return;
    const toStage = me.facing;
    switch (lpn.opt) {
      case 'climb':
        c.moveY = 1;
        c.moveX = toStage;
        break;
      case 'jump':
        this.doJump(this.lastThinkFrame, toStage);
        c.jumpHeld = true;
        this.preferLandUntil = this.lastThinkFrame + 100;
        break;
      case 'roll':
        c.dodge = true;
        c.moveX = toStage;
        break;
      case 'drop':
        c.moveY = -1;
        break;
    }
    this.ledgePlan = null;
  }

  // ── recovery ────────────────────────────────────────────────────────────

  /** Steering only (free-fall / mid-plan): toward the planned target, else the nearest ledge. */
  private steerRecovery(me: BrawlFighterState): void {
    const c = this.cur;
    const stage = this.stage as StageInfo;
    let tx = this.plan ? this.plan.tx : NaN;
    if (!Number.isFinite(tx)) {
      const L = stage.nearestLedge(me.pos.x, me.pos.y);
      tx = L ? L.x - L.side * 0.9 : stage.centerX;
    }
    c.moveX = steerTo(me.pos.x, me.vel.x, tx, this.stats.airSpeed);
    c.moveY = 0;
  }

  private doRecover(me: BrawlFighterState, snap: BrawlSnapshot): void {
    const c = this.cur;
    const lp = this.lp;
    this.mode = 'recover';
    if (snap.frame < this.diveUntil) {
      // a deliberate stalemate dive: do not come back
      this.mode = 'dive';
      c.moveX = this.diveDir * 0.3;
      c.moveY = -1;
      return;
    }
    const st = this.stats;
    // (re)plan
    const every = this.plan && this.plan.kind === 'fallback' ? 14 : lp.recovery >= 3 ? 5 : 8;
    const replan = !this.plan || snap.frame - this.plan.at >= every;
    if (replan) this.plan = this.makePlan(me, snap);
    const p = this.plan as RecPlan;
    // fumbling (level 1): sloppy steering and random resource use
    if (lp.recovery === 0) {
      c.moveY = 0;
      if (this.rng() < 0.55) c.moveX = sgn(p.tx - me.pos.x);
      else if (this.rng() < 0.3) c.moveX = 0;
      const hand = p.tx;
      void hand;
      if (me.jumpsLeft > 0 && me.pos.y < p.jumpY && me.vel.y < 1 && this.rng() < 0.12) this.doJump(snap.frame, c.moveX);
      else if (!me.recoveryUsed && me.pos.y < p.heavyY && this.rng() < 0.05) this.recoveryAttack(me, p);
      return;
    }
    const miss = lp.recoveryMiss;
    c.moveY = 0;
    const steer = steerTo(me.pos.x, me.vel.x, p.tx, st.airSpeed);
    c.moveX = this.rng() < miss ? 0 : steer;
    if (st.glideFall !== undefined) c.jumpHeld = true;
    if (this.rng() < miss) return;
    const rising = me.vel.y > 1.0;
    const jumpOk = me.jumpsLeft > 0 && me.pos.y <= p.jumpY && !rising;
    const heavyOk = !me.recoveryUsed && me.pos.y <= p.heavyY && !rising && (!p.heavyLast || me.jumpsLeft === 0);
    if (p.heavyLast ? !jumpOk && heavyOk : heavyOk) this.recoveryAttack(me, p);
    else if (jumpOk) {
      c.jump = true;
      c.jumpHeld = true;
      this.jumpHoldUntil = snap.frame + 10;
    }
  }

  private recoveryAttack(me: BrawlFighterState, p: RecPlan): void {
    const c = this.cur;
    const dir = Math.abs(p.tx - me.pos.x) > 0.6 ? sgn(p.tx - me.pos.x) : me.facing;
    if (me.facing !== dir && Math.abs(p.tx - me.pos.x) > 0.6) {
      // turn first (the next tick presses it)
      c.moveX = dir * 0.8;
      return;
    }
    this.press('heavy', c.moveX, 1);
  }

  /** Recovery targets from a state: free ledges and platform tops, nearest first. */
  private recTargets(s0: RecState): RecTgt[] {
    const stage = this.stage as StageInfo;
    const st = this.stats;
    const tgts: RecTgt[] = [];
    for (let i = 0; i < stage.ledges.length; i++) {
      if (!this.ledgeFree(i)) continue;
      const L = stage.ledges[i];
      const p = stage.plats[L.plat];
      let cornerX = L.x;
      let platY = p.y;
      if (stage.dyn && p.moving) {
        // aim where the corner will be when we get there
        const lead = Math.min(70, Math.round((Math.hypot(L.x - s0.x, p.y - s0.y) / Math.max(1, st.airSpeed)) * 60 * 0.7));
        stage.rectAt(L.plat, lead, this.rectScratch);
        cornerX = L.side < 0 ? this.rectScratch.x0 : this.rectScratch.x1;
        platY = this.rectScratch.y;
      }
      const sp = ledgeSpot(cornerX, L.side, platY, st);
      tgts.push({ kind: 'ledge', tx: sp.x, ty: sp.y, ledge: i, plat: L.plat, d: Math.hypot(sp.x - s0.x, (sp.y - s0.y) * 1.3) + (this.crossGoal >= 0 && L.plat !== this.crossGoal ? 8 : 0) + (this.lastThinkFrame < this.preferLandUntil ? 7 : 0) });
    }
    for (let i = 0; i < stage.plats.length; i++) {
      const p = stage.plats[i];
      if (!p.active) continue;
      if (p.y < s0.y - 0.3) continue;
      let px0 = p.x0;
      let px1 = p.x1;
      let py = p.y;
      if (stage.dyn && p.moving) {
        const lead = Math.min(60, Math.round((Math.abs((px0 + px1) * 0.5 - s0.x) / Math.max(1, st.airSpeed)) * 60 * 0.7));
        stage.rectAt(i, lead, this.rectScratch);
        px0 = this.rectScratch.x0;
        px1 = this.rectScratch.x1;
        py = this.rectScratch.y;
      }
      const lo = px0 + 0.9;
      const hi = px1 - 0.9;
      const tx = lo <= hi ? clamp(s0.x, lo, hi) : (px0 + px1) * 0.5;
      const p_y = py;
      tgts.push({ kind: 'land', tx, ty: p_y, ledge: -1, plat: i, d: Math.hypot(tx - s0.x, (p.y - s0.y) * 1.3) + 1.5 + (this.crossGoal >= 0 && i !== this.crossGoal ? 8 : 0) });
    }
    tgts.sort((a, b) => a.d - b.d);
    return tgts;
  }

  /** First resource policy that makes it back, per target (cheapest first; hopeless targets are skipped by a height bound). */
  private searchRecovery(s0: RecState, tgts: RecTgt[], maxTargets: number, budget0: number, stopAt: number): RecWin[] {
    const st = this.stats;
    const env = this.recEnv as RecEnv;
    const glide = st.glideFall !== undefined;
    const hasJump = s0.jumps > 0 && !s0.freeFall;
    const hasHeavy = !s0.recoveryUsed && !s0.freeFall;
    const hJump = (st.airJumpVel * st.airJumpVel) / (2 * GRAV * st.gravityMult);
    const gain = (hasJump ? s0.jumps * hJump : 0) + (hasHeavy ? this.ai.recPeak + 0.5 : 0) + (s0.vy > 0 ? (s0.vy * s0.vy) / (2 * GRAV * st.gravityMult) : 0);
    const wins: RecWin[] = [];
    let budget = budget0;
    let tried = 0;
    for (let k = 0; k < tgts.length && tried < maxTargets && budget > 0; k++) {
      const t = tgts[k];
      const H = t.ty;
      if (s0.y + gain < H - 1.2) continue;
      tried++;
      const base = { tx: t.tx, glide };
      const pols: RecPolicy[] = [{ ...base, jumpY: NEG_INF, heavyY: NEG_INF, heavyLast: true }];
      if (hasJump) for (const jy of [H + 1.2, H - 0.8]) pols.push({ ...base, jumpY: jy, heavyY: NEG_INF, heavyLast: true });
      if (hasHeavy) {
        for (const jy of hasJump ? [H + 1.2, H - 0.8] : [NEG_INF]) {
          for (const hy of [H + 0.6, H - 1.6, H - 3.2]) pols.push({ ...base, jumpY: jy, heavyY: hy, heavyLast: true });
        }
        if (hasJump) for (const hy of [H + 0.6, H - 1.8]) pols.push({ ...base, jumpY: hy - 2, heavyY: hy, heavyLast: false });
      }
      for (const pol of pols) {
        const r = simRecovery(env, s0, pol, 130);
        budget -= r.frames + 4;
        if (r.ok) {
          wins.push({ t, pol, frames: r.frames });
          break;
        }
        if (budget <= 0) break;
      }
      if (wins.length >= stopAt) break;
    }
    return wins;
  }

  private readonly rectScratch = { x0: 0, x1: 0, y: 0 };
  private recMemo = new Map<number, boolean>();
  private recMemoFrame = -1;

  /** Could the fighter, standing in the air at this state, still make it back to the stage? (memoised per frame) */
  private canRecoverFrom(x: number, y: number, vx: number, vy: number, jumps: number, recUsed: boolean, snap: BrawlSnapshot): boolean {
    if (this.recMemoFrame !== snap.frame) {
      this.recMemo.clear();
      this.recMemoFrame = snap.frame;
    }
    const key = (Math.round(x * 2) * 997 + Math.round(y * 2)) * 31 + jumps * 2 + (recUsed ? 1 : 0);
    const hit = this.recMemo.get(key);
    if (hit !== undefined) return hit;
    const s0: RecState = { x, y, vx, vy, jumps, recoveryUsed: recUsed, ledgeCd: 0, facing: x < this.stage!.centerX ? 1 : -1, freeFall: false };
    const ok = this.searchRecovery(s0, this.recTargets(s0), 3, 500, 1).length > 0;
    this.recMemo.set(key, ok);
    return ok;
  }

  private makePlan(me: BrawlFighterState, snap: BrawlSnapshot): RecPlan {
    const stage = this.stage as StageInfo;
    const lp = this.lp;
    const st = this.stats;
    const glide = st.glideFall !== undefined;
    const s0: RecState = {
      x: me.pos.x,
      y: me.pos.y,
      vx: me.vel.x,
      vy: me.vel.y,
      jumps: me.jumpsLeft,
      recoveryUsed: !!me.recoveryUsed,
      ledgeCd: me.ledgeCd ?? 0,
      facing: me.facing,
      freeFall: me.freeFall === true,
    };
    const tgts = this.recTargets(s0);
    const nearest = tgts.find((t) => t.kind === 'ledge') ?? tgts[0];
    const fallback = (): RecPlan => {
      const H = nearest ? nearest.ty : 0;
      return { tx: nearest ? nearest.tx : stage.centerX, jumpY: H + 1.0, heavyY: H - 1.0, heavyLast: true, glide, kind: 'fallback', ledge: nearest ? nearest.ledge : -1, at: snap.frame };
    };
    // level 1-2: greedy rules to the nearest ledge, no simulation
    if (lp.recovery < 2) {
      const f = fallback();
      f.jumpY += lp.recovery === 0 ? 0.3 : -0.2;
      return f;
    }
    const wins = this.searchRecovery(s0, tgts, lp.recovery >= 3 ? 4 : 2, 900, lp.recovery >= 3 ? 99 : 2);
    if (wins.length === 0) return fallback();
    // choose: level 3 the closest success; level 4 mixes ledge vs high return by threat and style
    let pick = wins[0];
    if (lp.recovery >= 3 && wins.length > 1) {
      const lw = wins.find((w) => w.t.kind === 'ledge');
      const hw = wins.find((w) => w.t.kind === 'land');
      if (lw && hw) {
        let threatened = false;
        for (let i = 0; i < this.nOpps; i++) {
          const o = this.opps[i];
          if (o.offstage || o.s.action === 'ko') continue;
          if (Math.abs(o.x - lw.t.tx) < 4.2 && Math.abs(o.y - lw.t.ty) < 4 && (o.free === 0 || o.s.action === 'attack')) threatened = true;
        }
        const pHigh = threatened ? 0.8 : this.tac.recovery === 'high' ? 0.45 : 0.15;
        // commit to one choice for a while so the plan does not flip every frame
        pick = this.planSticky(snap, this.rng() < pHigh ? hw : lw, lw, hw);
      }
    }
    return { tx: pick.t.tx, jumpY: pick.pol.jumpY, heavyY: pick.pol.heavyY, heavyLast: pick.pol.heavyLast, glide, kind: pick.t.kind, ledge: pick.t.ledge, at: snap.frame };
  }

  private planSticky<T extends { t: { kind: 'ledge' | 'land' } }>(_snap: BrawlSnapshot, chosen: T, lw: T, hw: T): T {
    const cur = this.plan;
    if (cur && cur.kind === 'land') return hw;
    if (cur && cur.kind === 'ledge') return lw;
    return chosen;
  }

  // ── ground play ─────────────────────────────────────────────────────────

  private doGround(me: BrawlFighterState, snap: BrawlSnapshot): void {
    const c = this.cur;
    const lp = this.lp;
    this.plan = null;
    this.ledgePlan = null;
    this.crossGoal = -1;
    const tgt = this.pickTarget();
    if (!tgt) {
      this.mode = 'idle';
      c.moveX = 0;
      c.moveY = 0;
      return;
    }
    if (lp.engine === 0) {
      this.mashGround(me, tgt, snap);
      return;
    }
    // defence: step out of range or dodge incoming hits; offence: the best attack by expected value (trade-aware)
    const thr = this.worstThreat(me);
    const cand = this.bestAttack(me, tgt, false, snap, thr);
    if (BrawlBot.DEBUG) {
      this.why = `thr ${thr ? thr.o.s.moveId + ' tF' + thr.tFirst + ' tL' + thr.tLast + ' mf0' + thr.mf0 : '-'} cand ${cand ? cand.id + ' t' + cand.frame + ' s' + cand.score.toFixed(1) : '-'} tgt d${tgt.dist.toFixed(1)} free${tgt.free} ${tgt.s.action}`;
    }
    if (thr) {
      if (cand && cand.frame < thr.tFirst - 4 && cand.score > 2.5 && !this.armoredAt(thr, cand.frame)) {
        // our faster move interrupts theirs
      } else {
        const esc = lp.engine === 2 && thr.tFirst >= 6 ? this.escapeDir(me, thr) : 0;
        if (esc !== 0 && this.rng() < 0.85) {
          this.mode = 'retreat';
          c.moveX = esc;
          c.moveY = 0;
          return;
        }
        if (this.shouldDodge(me, thr)) {
          this.mode = 'dodge';
          c.dodge = true;
          c.moveX = 0;
          c.moveY = 0;
          return;
        }
      }
    }
    if (cand) {
      this.mode = 'attack:' + cand.id;
      this.pressCand(me, cand);
      return;
    }
    this.neutral(me, tgt, snap);
  }

  /** Level 1: walk toward the nearest foe, mash Light when close, jump at random. */
  private mashGround(me: BrawlFighterState, t: Opp, snap: BrawlSnapshot): void {
    const c = this.cur;
    this.mode = 'mash';
    const dir = sgn(t.dx);
    c.moveY = 0;
    if (snap.frame >= this.wanderUntil) {
      this.wanderDir = this.rng() < 0.75 ? dir : (-dir as 1 | -1);
      this.wanderUntil = snap.frame + 12 + Math.floor(this.rng() * 30);
    }
    const near = t.dist < 2.4 && Math.abs(t.dy) < 2.4;
    if (near) {
      c.moveX = this.rng() < 0.6 ? dir * 0.5 : 0;
      if (snap.frame >= this.mashAt) {
        const r = this.rng();
        if (r < 0.82) this.press('light', this.rng() < 0.4 ? dir : 0, 0);
        else if (r < 0.94) this.press('heavy', this.rng() < 0.5 ? dir : 0, 0);
        else this.doJump(snap.frame, dir);
        this.mashAt = snap.frame + 6 + Math.floor(this.rng() * 8);
      }
      return;
    }
    c.moveX = this.edgeBlocked(me, this.wanderDir, 0.35) ? 0 : this.wanderDir;
    if (t.dy > 1.5 && t.dist < 4 && this.rng() < 0.25) this.doJump(snap.frame, dir);
    else if (this.rng() < 0.03) this.doJump(snap.frame, c.moveX);
  }

  /** True when walking `dir` would take the fighter off a platform with nothing below. Level-dependent carelessness. */
  private edgeBlocked(me: BrawlFighterState, dir: number, careless: number): boolean {
    if (dir === 0) return false;
    if (this.rng() < careless && this.lp.edgeSafe < 1) return false;
    const stage = this.stage as StageInfo;
    const pi = stage.platIndex(me.platformId);
    if (pi < 0) return false;
    const p = stage.plats[pi];
    if (stage.dyn) {
      // dynamic stage: touching platforms at one height are one floor (the Amphitheatre's tiles); a pit or a vanished platform is a real edge
      stage.runSpan(pi, this.span);
      const e = dir > 0 ? this.span.hi : this.span.lo;
      if ((e - me.pos.x) * dir > 1.3) return false;
      return stage.platformBelow(e + dir * 0.8, me.pos.y + 0.35, this.stats.width, 0) < 0;
    }
    const edge = dir > 0 ? p.x1 : p.x0;
    const toEdge = (edge - me.pos.x) * dir;
    if (toEdge > 1.3) return false;
    // something to land on just beyond the edge?
    return stage.platformBelow(edge + dir * 0.8, me.pos.y - 0.4, this.stats.width, 0) < 0;
  }

  // ── threats / defence ───────────────────────────────────────────────────

  private readonly thrObj: Threat = { o: null as unknown as Opp, info: null as unknown as MoveInfo, mf0: 0, tFirst: 0, tLast: 0, dmg: 0 };

  private worstThreat(me: BrawlFighterState): Threat | null {
    let found = false;
    const t = this.thrObj;
    const D = this.lp.adjust ? this.delayUsed : 0;
    for (let i = 0; i < this.nOpps; i++) {
      const o = this.opps[i];
      const s = o.s;
      if (s.action !== 'attack' || !s.moveId || o.dist > 7.5) continue;
      const info = moveInfo(s.animal, s.moveId, s.moveAir, s.moveChain);
      const mf0 = Math.min(s.moveFrame + D, info.total);
      if (mf0 >= info.last) continue;
      const f = s.facing;
      const startX = o.x - f * info.dispX[Math.min(mf0, info.total)];
      const startY = o.y - info.dispY[Math.min(mf0, info.total)];
      const relX = (me.pos.x - startX) * f;
      const relY = me.pos.y - startY;
      const pr = probeHit(info, relX, relY, this.stats.width, this.stats.height, 0, 0, 0, mf0 + 1);
      if (pr.frame < 0) continue;
      const tFirst = pr.frame - mf0;
      if (found && tFirst >= t.tFirst) continue;
      found = true;
      t.o = o;
      t.info = info;
      t.mf0 = mf0;
      t.tFirst = tFirst;
      t.tLast = info.last - 1 - mf0;
      t.dmg = info.damage;
    }
    return found ? t : null;
  }

  /**
   * Stick direction that gets us out of the incoming move's reach in time (0 = not possible / not needed).
   * Stepping out of a slow attack and punishing its endlag beats burning the dodge.
   */
  private escapeDir(me: BrawlFighterState, thr: Threat): number {
    const o = thr.o;
    const info = thr.info;
    const f = o.s.facing;
    const mf0 = thr.mf0;
    const startX = o.x - f * info.dispX[Math.min(mf0, info.total)];
    const startY = o.y - info.dispY[Math.min(mf0, info.total)];
    const away = me.pos.x >= o.x ? 1 : -1;
    const frames = thr.tFirst - 1;
    if (frames < 3) return 0;
    const run = this.stats.runSpeed;
    const can = Math.max(0, (run * frames) / 60 - 0.5);
    for (const d of [0.7, 1.4, 2.1, 2.8, 3.5, 4.2]) {
      if (d > can) return 0;
      const relX = (me.pos.x + away * d - startX) * f;
      const pr = probeHit(info, relX, me.pos.y - startY, this.stats.width, this.stats.height, 0, 0, 0, mf0 + 1);
      if (pr.frame < 0) {
        if (this.edgeBlocked(me, away, 0)) return 0;
        return away;
      }
    }
    return 0;
  }

  /** Is the incoming attacker armored (our hit would not stop it) when our move lands `t` steps from now? */
  private armoredAt(thr: Threat, t: number): boolean {
    const a = thr.info.armor;
    if (!a) return false;
    const mf = thr.mf0 + t;
    return mf >= a.from - 1 && mf < a.to + 2;
  }

  private shouldDodge(me: BrawlFighterState, thr: Threat): boolean {
    const lp = this.lp;
    if (lp.dodge <= 0 || me.dodgeCd > 0 || me.freeFall) return false;
    if (thr.tFirst < 1) return false;
    // press as early as the whole active window still fits inside the 14 invulnerable frames
    const window = this.stats.dodgeInvuln;
    if (thr.tLast > window) return false;
    const key = thr.o.s.id;
    const seen = this.threatSeen.get(key) ?? -1000;
    const snapFrame = this.hist[this.hist.length - 1].frame;
    if (snapFrame - seen > 40) {
      this.threatSeen.set(key, snapFrame);
      const sev = clamp(thr.dmg / 14, 0.35, 1);
      this.threatDodge.set(key, this.rng() < lp.dodge * sev * (me.percent > 90 ? 1.2 : 1));
    }
    return this.threatDodge.get(key) === true;
  }

  // ── attack engine ───────────────────────────────────────────────────────

  private oppMotion(o: Opp, out: { vx: number; vy: number; ay: number }): void {
    const s = o.s;
    const gm = o.st.gravityMult;
    if (s.action === 'hitstun' || s.action === 'tumble') {
      out.vx = o.vx * (o.grounded ? 0.25 : 0.8);
      out.vy = o.grounded ? 0 : o.vy;
      out.ay = o.grounded ? 0 : -GRAV * 0.85 * gm;
    } else if (!o.grounded && !o.hanging) {
      out.vx = o.vx * 0.9;
      out.vy = o.vy;
      out.ay = -GRAV * gm;
    } else {
      out.vx = o.vx * 0.35;
      out.vy = 0;
      out.ay = 0;
    }
  }

  private readonly motion = { vx: 0, vy: 0, ay: 0 };
  private readonly best: Cand = { id: 'lightN', air: false, dir: 1, score: 0, frame: 0, kill: false };

  private chainDamage(): number {
    const a = this.animal as AnimalId;
    let d = moveInfo(a, 'lightN', false, 0).damage;
    const n = MOVESETS[a].moves.lightN.chain?.length ?? 0;
    for (let i = 1; i <= n; i++) d += moveInfo(a, 'lightN', false, i).damage;
    return d;
  }

  /** Best attack to start right now against `o`, or null. */
  private bestAttack(me: BrawlFighterState, o: Opp, air: boolean, snap: BrawlSnapshot, thr: Threat | null): Cand | null {
    const lp = this.lp;
    const tac = this.tac;
    const animal = this.animal as AnimalId;
    if (o.dist > this.ai.reachAll + 5 || Math.abs(o.dy) > 7) return null;
    if (lp.engine === 0) return null;
    const dirT = sgn(o.dx);
    this.oppMotion(o, this.motion);
    const m = this.motion;
    const ids = air ? AIR_IDS : GROUND_IDS;
    const pressure = this.pressureNow(snap);
    const smart = lp.engine === 2;
    // distance misjudgement for sloppy levels
    const err = lp.noise > 0 ? (this.rng() - 0.5) * 2 * lp.noise : 0;
    const best = this.best;
    let found = false;
    best.score = -Infinity;
    const committed = o.free > 0 && (smart || o.free > 8);
    for (const id of ids) {
      const md = MOVESETS[animal].moves[id];
      if (air ? md.groundOnly : md.airOnly) continue;
      if (id === 'heavyU' && !air && !(o.dy > 1.2 || o.s.percent > 80 || smart)) continue;
      const info = moveInfo(animal, id, air, 0);
      const isS = id.endsWith('S');
      let face: 1 | -1 = me.facing;
      const tb = info.body.turnOnStart;
      if (tb !== undefined ? tb : isS && !info.body.armor) face = dirT;
      const relX = (o.x - me.pos.x) * face + err;
      const relY = o.y - me.pos.y;
      const rvx = (m.vx - (air ? me.vel.x : 0)) * face;
      const rvy = m.vy - (air ? me.vel.y : 0);
      // a burrow tunnels at most to the end of the platform it stands on (the sim clamps it)
      let room = Infinity;
      if (info.stopsAtEdge && !air) {
        const pi = (this.stage as StageInfo).platformBelow(me.pos.x, me.pos.y, this.stats.width, 0.05);
        if (pi >= 0) {
          const pl = (this.stage as StageInfo).plats[pi];
          room = Math.max(0, face > 0 ? pl.x1 - me.pos.x : me.pos.x - pl.x0);
        }
      }
      const pr = probeHit(info, relX, relY, o.w, o.h, rvx, rvy, m.ay, 0, room);
      if (pr.frame < 0) continue;
      const t = pr.frame;
      if (smart && (air || info.travelX > 0.4 || info.travelY > 0.4) && this.rng() < lp.edgeSafe && this.endUnsafe(me, info, face, air, snap)) continue;
      // certainty that it lands
      let P: number;
      if (smart) {
        if (o.invuln > t) continue;
        const inReach = o.free > 0 && t <= o.free + 1;
        if (inReach && committed) P = 0.95;
        else {
          const react = Math.max(0, t - (o.free > 0 ? o.free : 0));
          P = clamp(0.9 - 0.035 * react, 0.08, 0.8);
        }
        if (info.armor && info.armor.from <= info.first - 2 && P < 0.5) P = 0.5;
      } else {
        P = committed && t <= o.free + 1 ? 0.8 : 0.45;
      }
      // an armored opponent shrugs off a hit that lands inside its armor window
      if (smart && o.s.action === 'attack' && o.s.moveId) {
        const oi = moveInfo(o.s.animal, o.s.moveId, o.s.moveAir, o.s.moveChain);
        if (oi.armor) {
          const mfT = o.s.moveFrame + (lp.adjust ? this.delayUsed : 0) + t;
          if (mfT >= oi.armor.from - 1 && mfT < oi.armor.to + 1) P *= 0.15;
        }
      }
      // trade awareness: an incoming hit that lands before ours (or through its armor) is not interrupted
      let extraRisk = 0;
      if (smart && thr) {
        const tThr = thr.tFirst;
        const interrupts = t < tThr - 4 && !this.armoredAt(thr, t);
        if (!interrupts) {
          const myArmor = info.armor !== null && tThr >= info.armor.from && tThr < info.armor.to;
          const myInv = info.invuln !== null && tThr >= info.invuln.from && tThr < info.invuln.to;
          if (myInv) {
            // phases through the hit
          } else if (myArmor) {
            extraRisk += thr.dmg * 0.4;
          } else {
            P *= 0.12;
            extraRisk += thr.dmg * (0.9 + me.percent / 150);
          }
        }
      }
      // value
      let dmg = info.damage;
      if (id === 'lightN' && !air) dmg = this.chainDamage() * 0.72;
      if (pr.sweet && pr.box && pr.box.hb.sweet) dmg = Math.max(dmg, info.damage * pr.box.hb.sweet.damageMult);
      let value = dmg;
      let kill = false;
      if (smart && o.s.percent >= 35 && info.main.baseKb + info.main.kbGrowth >= 18 && info.main.effect !== 'pull' && info.main.effect !== 'bury') {
        kill = this.killsOn(me, o, pr.box ? pr.box.hb : info.main, pr.sweet, face, o.s.percent + dmg);
        if (kill) value += 55;
      }
      if (smart) value += (info.main.baseKb + info.main.kbGrowth * (o.s.percent / 100)) * 0.05;
      // risk of a whiff: endlag, landing lag low in the air
      let endlag = info.endlag + info.first * 0.5;
      if (air) {
        const fl = (this.stage as StageInfo).platformBelow(me.pos.x, me.pos.y, this.stats.width, 0.3);
        if (fl >= 0 && me.pos.y - (this.stage as StageInfo).plats[fl].y < 2.2) endlag += info.body.landingLag ?? 10;
      }
      let risk = (1 - P) * endlag * 0.2 + extraRisk;
      if ((this.stage as StageInfo).hasBreakables) risk -= this.breakAdjust(me, o, info, face);
      let bias = tac.bias[id] ?? 1;
      if (!committed && tac.risky.includes(id) && !kill && smart) bias *= 0.55;
      if (air && tac.aerials.includes(id)) bias *= 1.1;
      if (!smart) bias *= 0.85 + this.rng() * 0.3;
      let score = P * value * bias - risk;
      if (lp.mix > 0) score *= 1 + (this.rng() - 0.5) * lp.mix;
      // pressure: stalling bots get bolder
      score += pressure * 2.5;
      if (score > best.score) {
        best.score = score;
        best.id = id;
        best.air = air;
        best.dir = face === me.facing && !isS ? me.facing : dirT;
        best.frame = t;
        best.kill = kill;
        found = true;
      }
    }
    if (!found) return null;
    const minScore = (smart ? 1.6 : 1.0) / Math.max(0.3, lp.aggression);
    if (best.score < minScore) return null;
    return best;
  }

  /**
   * Integrates the move's motion windows from the fighter's current state (grounded fighters leave the ground when
   * the motion carries them past the platform edge). Returns false if the fighter ends up standing on a platform
   * (safe); otherwise `endState` holds where and how fast it is when the move ends and control returns.
   */
  private readonly endState = { x: 0, y: 0, vx: 0, vy: 0 };

  private moveEnd(me: BrawlFighterState, info: MoveInfo, face: 1 | -1, air: boolean): boolean {
    const stage = this.stage as StageInfo;
    const st = this.stats;
    const body = info.body;
    let x = me.pos.x;
    let y = me.pos.y;
    let vx = me.vel.x;
    let vy = air ? me.vel.y : 0;
    let grounded = !air;
    // a stopAtEdge window keeps a grounded fighter on its platform (v1.6 burrow)
    const stopPlat = !air && info.stopsAtEdge ? stage.platformBelow(x, y, st.width, 0.05) : -1;
    for (let mf = 0; mf < info.total; mf++) {
      let g = 1;
      let setX = false;
      let setY = false;
      let edge = false;
      if (body.motion) {
        for (const m of body.motion) {
          if (mf < m.from || mf >= m.to) continue;
          if (m.stopAtEdge) edge = true;
          const mvx = m.vx !== undefined ? m.vx * face : 0;
          const mvy = m.vy ?? 0;
          if (m.set) {
            if (m.vx !== undefined) {
              vx = mvx;
              setX = true;
            }
            if (m.vy !== undefined) {
              vy = mvy;
              setY = true;
            }
          } else {
            vx += mvx;
            vy += mvy;
            if (m.vx !== undefined) setX = true;
            if (m.vy !== undefined) setY = true;
          }
          if (m.gravity !== undefined) g = m.gravity;
        }
      }
      if (grounded) {
        if (!setX) vx *= 0.8;
        if (!air && body.burrow && mf === body.burrow.to) vx = 0;
        if (vy > 0) grounded = false;
      } else if (!setX) vx *= 0.985;
      if (!grounded) {
        vy -= GRAV * st.gravityMult * g * (1 / 60);
        if (!setY && vy < -st.fallSpeed) vy = -st.fallSpeed;
      }
      const ox = x;
      const oy = y;
      x += vx * (1 / 60);
      if (edge && grounded && stopPlat >= 0) {
        const sp = stage.plats[stopPlat];
        x = x < sp.x0 ? sp.x0 : x > sp.x1 ? sp.x1 : x;
      }
      if (!grounded) {
        y += vy * (1 / 60);
        if (vy < 0) {
          for (const p of stage.plats) {
            if (!p.active) continue;
            if (oy >= p.y - 1e-3 && y <= p.y + 1e-3 && supportedBy(x, st.width, p.x0, p.x1)) return false;
          }
        }
      } else {
        const i = stage.platformBelow(x, y, st.width, 0.05);
        if (i < 0 || Math.abs(stage.plats[i].y - y) > 0.1) {
          grounded = false;
          vy = 0;
        }
      }
      void ox;
    }
    if (grounded) return false;
    this.endState.x = x;
    this.endState.y = y;
    this.endState.vx = vx;
    this.endState.vy = vy;
    return true;
  }

  /** Would the move carry the fighter somewhere it cannot get back from (off the stage with no way home)? */
  private endUnsafe(me: BrawlFighterState, info: MoveInfo, face: 1 | -1, air: boolean, snap: BrawlSnapshot): boolean {
    if (!this.moveEnd(me, info, face, air)) return false;
    const st = this.stats;
    const e = this.endState;
    if ((this.stage as StageInfo).platformBelow(e.x, e.y, st.width, 0.3) >= 0) return false;
    const jumps = air ? me.jumpsLeft : st.maxJumps - 1;
    const recUsed = air ? !!me.recoveryUsed || info.id === 'heavyU' : false;
    return !this.canRecoverFrom(e.x, e.y, e.vx, e.vy, jumps, recUsed, snap);
  }

  /** Does `hb` launch `o` out of the stage from where it stands (with a little survival DI assumed)? */
  private killsOn(me: BrawlFighterState, o: Opp, hb: HitboxDef, sweet: boolean, face: 1 | -1, pctAfter: number): boolean {
    const stage = this.stage as StageInfo;
    const sw = sweet && hb.sweet ? hb.sweet : null;
    let kb = (hb.baseKb + (hb.kbGrowth * pctAfter) / 100) * (sw ? sw.kbMult : 1) * (100 / Math.max(1, o.st.weight));
    if (kb > 62) kb = 62;
    if (kb < 18) return false;
    let deg = face === 1 ? hb.angle : 180 - hb.angle;
    deg = ((deg % 360) + 360) % 360;
    const rad = (deg * Math.PI) / 180;
    let vx = Math.cos(rad) * kb;
    let vy = Math.sin(rad) * kb;
    if (o.grounded) {
      if (vy < 0) vy = -vy * 0.8;
      if (Math.abs(vy) < 0.5) return false;
    }
    void me;
    const stun = clamp(Math.floor(kb * 0.6 * (hb.hitstunScale ?? 1)), 6, 60);
    const g = o.st.gravityMult;
    // the victim's best survival DI (level 3+ opponents) is ±8°
    const base = flight(stage, o.x, o.y, vx, vy, stun, g, o.st.fallSpeed, o.st.width, 0).kill;
    if (!base) return false;
    const a = flight(stage, o.x, o.y, vx, vy, stun, g, o.st.fallSpeed, o.st.width, 8).kill;
    if (!a) return false;
    vx = vx + 0; // (kept symmetrical)
    return flight(stage, o.x, o.y, vx, vy, stun, g, o.st.fallSpeed, o.st.width, -8).kill;
  }

  private pressCand(me: BrawlFighterState, cd: Cand): void {
    const c = this.cur;
    const id = cd.id;
    const heavy = id.startsWith('heavy');
    const slot = id[id.length - 1];
    let mx = 0;
    let my = 0;
    if (slot === 'S') mx = cd.dir * 0.9;
    else if (slot === 'U') my = 1;
    else if (slot === 'D') my = -1;
    // the facing must already match for non-side moves (the move frame data assumes it)
    if (slot !== 'S' && me.facing !== cd.dir && !(moveInfo(this.animal as AnimalId, id, cd.air).twoSided)) {
      c.moveX = cd.dir * 0.6;
      c.moveY = 0;
      return;
    }
    if (slot === 'U' || slot === 'D') mx = 0;
    this.press(heavy ? 'heavy' : 'light', mx, my);
  }

  // ── neutral movement ────────────────────────────────────────────────────

  private neutral(me: BrawlFighterState, t: Opp, snap: BrawlSnapshot): void {
    const c = this.cur;
    const lp = this.lp;
    const tac = this.tac;
    const stage = this.stage as StageInfo;
    const dir = sgn(t.dx);
    this.mode = 'neutral';
    c.moveY = 0;
    c.moveX = 0;
    const pressure = this.pressureNow(snap);

    // v1.6 breakables: relocate off a nearly broken floor, or use the downtime to smash a piece
    if (stage.hasBreakables && lp.engine >= 1 && this.breakableNeutral(me, t, snap)) return;

    // stalemate on a broken-up arena: nobody can reach anybody (or the last pieces), nothing has happened for 25 s and we are not ahead:
    // sacrifice a stock - the respawn drops us into the middle of the arena, where the pieces are
    if (stage.hasBreakables && this.stalemateDive(me, t, snap)) return;
    // stall breaker: standing still for a long time (nothing reachable, everybody waiting): walk somewhere else on the floor
    if (this.stillBored(me, snap)) return;

    // vertical separation: different tier
    const myPlat = stage.platIndex(me.platformId);
    if (stage.dyn) {
      // dynamic stage: route over the platform graph (verified hops) to the floor the opponent stands on
      if (lp.engine >= 1 && !t.offstage && this.hopToward(me, this.goalPlat(t), snap, lp.level >= 3 ? 0.12 : lp.level === 2 ? 0.06 : 0)) return;
    } else if (lp.stagePlay || lp.engine === 1) {
      if (this.navigateTiers(me, t, myPlat, snap)) return;
    }

    // edge-guard: the opponent is off the stage — stand at the ledge it must reach
    if (lp.edgeGuard && (t.offstage || t.hanging) && snap.frame - this.stillSince < 180 && this.guardLedge(me, t)) return;

    // the opponent is on another island: cross the gap (Sky Aqueduct)
    if (!stage.dyn && lp.engine >= 1 && this.tryCross(me, t, snap, pressure)) return;

    // whiff-punish dash
    const punishable = t.free >= 6 && this.punishOk(t);
    let desired = tac.range;
    if (tac.approach === 'wait' && pressure < 0.4) desired += 0.3;
    desired *= 1 - pressure * 0.3;
    const aim = t.dist - desired;
    let want = 0;
    if (punishable) want = dir;
    else if (aim > 0.3) want = dir * (aim > 1.8 ? 1 : 0.55);
    else if (aim < -0.6 && lp.engine === 2 && t.free === 0) want = -dir * 0.5;
    // approach tools
    if (!punishable && tac.approach === 'jumpIn' && aim > 1 && aim < 5 && this.rng() < tac.jumpIn * lp.aggression && t.free === 0) {
      this.doJump(snap.frame, dir, true);
      this.mode = 'jumpin';
      return;
    }
    if (!punishable && tac.approach !== 'jumpIn' && aim > 1.5 && aim < 5 && this.rng() < tac.jumpIn * 0.5) {
      this.doJump(snap.frame, dir, lp.level >= 3);
      this.mode = 'jumpin';
      return;
    }
    if (want !== 0 && this.edgeBlocked(me, sgn(want), lp.level === 2 ? 0.35 : 0)) want = 0;
    if (want === 0 && me.facing !== dir && t.dist > 0.5) want = dir * 0.35;
    c.moveX = want;
  }

  /** Run to the island edge and jump across to where the opponent stands. Returns true when it set the stick. */
  private tryCross(me: BrawlFighterState, t: Opp, snap: BrawlSnapshot, pressure: number): boolean {
    const stage = this.stage as StageInfo;
    const lp = this.lp;
    const c = this.cur;
    if (!me.grounded || t.offstage) return false;
    const si = stage.platIndex(me.platformId);
    if (si < 0 || !stage.plats[si].solid) return false;
    let ti = -1;
    for (let i = 0; i < stage.plats.length; i++) {
      const p = stage.plats[i];
      if (p.solid && p.active && t.x > p.x0 - 0.5 && t.x < p.x1 + 0.5) {
        ti = i;
        break;
      }
    }
    if (ti < 0 || ti === si) return false;
    const S = stage.plats[si];
    const T = stage.plats[ti];
    let sx0 = S.x0;
    let sx1 = S.x1;
    if (stage.dyn) {
      // the target stands on the same walkable run (touching tiles): no crossing
      stage.runSpan(si, this.span);
      if (T.x1 > this.span.lo - 0.1 && T.x0 < this.span.hi + 0.1 && Math.abs(T.y - S.y) <= 0.12) return false;
      sx0 = this.span.lo;
      sx1 = this.span.hi;
    }
    const dir: 1 | -1 = T.x0 + T.x1 > sx0 + sx1 ? 1 : -1;
    const edge = dir > 0 ? sx1 : sx0;
    const toEdge = (edge - me.pos.x) * dir;
    // in no hurry: a level-3/4 bot first tries to make the opponent come (the stall breaker is `pressure`)
    if (pressure < 0.12 && lp.level >= 3 && t.free === 0 && this.rng() < 0.97) return false;
    if (toEdge > 0.55) {
      this.mode = 'to-gap';
      c.moveX = dir;
      c.moveY = 0;
      return true;
    }
    let go = true;
    if (lp.level >= 3 && pressure < 0.7) go = this.crossFeasible(me, S.y, dir, ti);
    else if (lp.level === 2) go = this.rng() < 0.6;
    if (!go) return false;
    this.mode = 'cross';
    this.crossGoal = ti;
    this.crossUntil = snap.frame + 100;
    this.doJump(snap.frame, dir);
    return true;
  }

  private crossFeasible(me: BrawlFighterState, platY: number, dir: 1 | -1, goal: number): boolean {
    const st = this.stats;
    const saved = this.crossGoal;
    this.crossGoal = goal;
    let ok = true;
    // the jump happens a few frames from now at a slightly different speed: it must work for both
    for (const k of [0.65, 1.0]) {
      const s0: RecState = {
        x: me.pos.x + dir * 0.35,
        y: platY,
        vx: dir * Math.max(st.airSpeed * 0.6, Math.abs(me.vel.x) * k),
        vy: st.jumpVel,
        jumps: st.maxJumps - 1,
        recoveryUsed: false,
        ledgeCd: 0,
        facing: dir,
        freeFall: false,
      };
      const tg = this.recTargets(s0).filter((x) => x.plat === goal);
      if (this.searchRecovery(s0, tg, 3, 700, 1).length === 0) {
        ok = false;
        break;
      }
    }
    this.crossGoal = saved;
    return ok;
  }

  private punishOk(t: Opp): boolean {
    const key = t.s.id;
    let v = this.punishFor.get(key);
    if (v === undefined || t.free === 0) {
      v = this.rng() < this.lp.punish;
      this.punishFor.set(key, v);
    }
    // feasibility: can we get there in time
    const run = this.stats.runSpeed;
    const need = Math.max(0, t.dist - this.ai.reachLight * 0.85);
    const frames = (need / run) * 60 + this.ai.fastestLight + 4;
    return v && frames <= t.free + 1;
  }

  /** Stand where an off-stage opponent has to come back; returns true when it set the stick. */
  private guardLedge(me: BrawlFighterState, t: Opp): boolean {
    const stage = this.stage as StageInfo;
    const c = this.cur;
    const L = stage.nearestLedge(t.x, t.y);
    if (!L) return false;
    const p = stage.plats[L.plat];
    if (me.platformId !== p.id) return false;
    const gx = L.x - L.side * 1.1;
    const dx = gx - me.pos.x;
    this.mode = 'edgeguard';
    c.moveX = Math.abs(dx) > 0.35 ? sgn(dx) * (Math.abs(dx) > 2 ? 1 : 0.5) : me.facing === -L.side ? 0 : -L.side * 0.4;
    // face outward
    if (Math.abs(dx) <= 0.35 && me.facing !== -L.side) c.moveX = -L.side * 0.4;
    return true;
  }

  /** Move toward / jump to / drop from the platform the target is on. Returns true if it acted. */
  private navigateTiers(me: BrawlFighterState, t: Opp, myPlat: number, snap: BrawlSnapshot): boolean {
    const c = this.cur;
    const stage = this.stage as StageInfo;
    const lp = this.lp;
    if (t.offstage) return false;
    const dy = t.y - me.pos.y;
    if (Math.abs(dy) < 1.6 && (t.grounded || Math.abs(t.dx) < 4)) return false;
    const stats = this.stats;
    if (dy > 1.6) {
      // target above: get under a platform edge and jump
      const jumpH = (stats.jumpVel * stats.jumpVel) / (2 * GRAV * stats.gravityMult);
      const airH = (stats.airJumpVel * stats.airJumpVel) / (2 * GRAV * stats.gravityMult) * (stats.maxJumps - 1);
      const reach = jumpH + airH - 0.3;
      // already near the target horizontally: jump at it
      if (t.dist < 3.2 && dy < reach) {
        if (this.rng() < 0.5 * lp.aggression + 0.2) this.doJump(snap.frame, sgn(t.dx));
        c.moveX = sgn(t.dx) * 0.6;
        this.mode = 'jump-up';
        return true;
      }
      // find a platform above that we can climb that leads toward the target
      let bestI = -1;
      let bestScore = Infinity;
      for (let i = 0; i < stage.plats.length; i++) {
        const p = stage.plats[i];
        if (!p.active) continue;
        const rise = p.y - me.pos.y;
        if (rise < 1 || rise > reach || i === myPlat) continue;
        const cx = clamp(me.pos.x, p.x0 - 0.5, p.x1 + 0.5);
        const dist = Math.abs(cx - me.pos.x);
        const toT = Math.abs(p.y - t.y) * 0.5 + Math.abs((p.x0 + p.x1) * 0.5 - t.x) * 0.3;
        const sc = dist + toT;
        if (sc < bestScore) {
          bestScore = sc;
          bestI = i;
        }
      }
      if (bestI >= 0) {
        const p = stage.plats[bestI];
        const inside = me.pos.x > p.x0 - 0.2 && me.pos.x < p.x1 + 0.2;
        if (inside) {
          this.doJump(snap.frame, 0);
          this.mode = 'jump-plat';
        } else {
          const gx = me.pos.x < p.x0 ? p.x0 - 0.2 : p.x1 + 0.2;
          const d = gx - me.pos.x;
          c.moveX = this.edgeBlocked(me, sgn(d), 0) ? 0 : clamp(d, -1, 1);
          if (Math.abs(d) < 1.2 && me.grounded) this.doJump(snap.frame, sgn(d));
          this.mode = 'to-plat';
        }
        return true;
      }
      return false;
    }
    // target below: drop through a soft platform / walk off toward it
    if (dy < -1.6 && myPlat >= 0 && !stage.plats[myPlat].solid && t.dist < 6) {
      c.moveY = -1;
      c.moveX = sgn(t.dx) * 0.3;
      this.mode = 'drop';
      return true;
    }
    return false;
  }

  // ── v1.6 breakables ─────────────────────────────────────────────────────

  /** First move frame at which `info` (started now, facing `face`, feet at (x, y)) would count a hit on platform `p`; -1 = never. */
  private hitsPlatform(info: MoveInfo, x: number, y: number, face: 1 | -1, p: Plat): number {
    const pad = PHYS.platHitPad;
    const rx0 = face > 0 ? p.x0 - pad - x : x - (p.x1 + pad);
    const rx1 = face > 0 ? p.x1 + pad - x : x - (p.x0 - pad);
    return probeRect(info, rx0, rx1, p.y - p.thickness - pad - y, p.y + pad - y);
  }

  /**
   * Score adjustment (added to the move's value) for what the move does to the BREAKABLE platforms: a hit that would break the floor
   * under our own feet is (nearly) forbidden, chipping a floor that is two hits from breaking is discouraged, breaking the piece under
   * a grounded opponent is a bonus (it falls).
   */
  private breakAdjust(me: BrawlFighterState, o: Opp, info: MoveInfo, face: 1 | -1): number {
    const stage = this.stage as StageInfo;
    const own = me.grounded ? stage.platIndex(me.platformId) : -1;
    // standing at a seam the sim may count either piece as ours
    const own2 = me.grounded ? stage.platformBelow(me.pos.x, me.pos.y, this.stats.width, 0.05) : -1;
    const oppI = o.grounded ? stage.platIndex(o.s.platformId) : -1;
    let adj = 0;
    let breaksOwn = false;
    const lastPiece = stage.activeBreakCount() === 1;
    for (let n = 0; n < stage.breakIdx.length; n++) {
      const j = stage.breakIdx[n];
      const p = stage.plats[j];
      if (!p.active || p.hp <= 0) continue;
      // an aerial near a floor hits it as it falls: count every breakable just below us as "ours"
      const below = !me.grounded && p.y <= me.pos.y + 0.3 && p.y >= me.pos.y - 3.5 && me.pos.x > p.x0 - 2.5 && me.pos.x < p.x1 + 2.5;
      const mine = j === own || j === own2 || below;
      if (!mine && j !== oppI) continue;
      const yy = below ? p.y : me.pos.y;
      if (this.hitsPlatform(info, me.pos.x, yy, face, p) < 0) continue;
      if (mine) {
        // the very last piece: breaking it flips the arena to its final form (new platforms rise), so it is worth the fall
        if (lastPiece && me.jumpsLeft > 0) continue;
        if (p.hp <= 1) {
          adj -= p.solid ? 30 : 5;
          breaksOwn = true;
        } else if (p.hp <= 2 && p.solid && this.lp.level >= 3) adj -= 3;
      } else if (p.hp <= 1 && p.solid) adj += 9;
      else if (p.hp <= 1) adj += 4;
    }
    if (breaksOwn) adj = Math.min(adj, -30);
    return adj;
  }

  /**
   * Neutral-time behaviours on stages with breakable pieces. Returns true when it set the stick. (1) Level 3+: leave a floor that is two
   * hits from breaking while the opponent is around. (2) Level 2+: in the downtime (opponent far away) smash a nearby piece: the soft
   * arches and the crown by standing on them, the tiles from the run of floor we stand on; never the last hits of the floor under us.
   */
  private breakableNeutral(me: BrawlFighterState, t: Opp, snap: BrawlSnapshot): boolean {
    const stage = this.stage as StageInfo;
    const lp = this.lp;
    const c = this.cur;
    if (!me.grounded) return false;
    const mi = stage.platIndex(me.platformId);
    if (mi < 0) return false;
    const mp = stage.plats[mi];
    // (1) a nearly broken solid floor under us while the opponent is near: walk to a sturdier piece of the same run (committed, then a cooldown)
    if (snap.frame < this.relocUntil) {
      const d = this.relocTx - me.pos.x;
      if (Math.abs(d) > 0.5) {
        this.mode = 'relocate';
        c.moveX = sgn(d);
        c.moveY = 0;
        return true;
      }
      this.relocUntil = 0;
      this.relocCool = snap.frame + 300;
    }
    if (lp.level >= 3 && snap.frame >= this.relocCool && mp.breakable && mp.solid && mp.hp <= 2 && t.dist < 5 && Math.abs(t.dy) < 4) {
      stage.runSpan(mi, this.span);
      let bj = -1;
      let bd = Infinity;
      for (let j = 0; j < stage.plats.length; j++) {
        const q = stage.plats[j];
        if (j === mi || !q.active || !q.solid || Math.abs(q.y - mp.y) > 0.12) continue;
        if (q.x1 < this.span.lo - 0.1 || q.x0 > this.span.hi + 0.1) continue;
        if (q.breakable && q.hp <= 2) continue;
        const d = Math.abs((q.x0 + q.x1) * 0.5 - me.pos.x);
        if (d < bd) {
          bd = d;
          bj = j;
        }
      }
      if (bj >= 0) {
        const q = stage.plats[bj];
        this.relocTx = clamp(me.pos.x, q.x0 + 1.2, q.x1 - 1.2);
        if (Math.abs(this.relocTx - me.pos.x) > 0.5) {
          this.relocUntil = snap.frame + 90;
          this.mode = 'relocate';
          c.moveX = sgn(this.relocTx - me.pos.x);
          c.moveY = 0;
          return true;
        }
      }
    }
    // (2) downtime: smash a piece
    if (this.smashAppetite <= 0) return false;
    const near = (t.dist < 4.6 && Math.abs(t.dy) < 3.5) || (t.s.action === 'attack' && t.dist < 7) || t.offstage;
    if (near) {
      this.smashPlan = null;
      return false;
    }
    // the last piece, or a long standoff: breaking even the floor under us is worth it (the final form catches us, a stall helps nobody)
    const desperate = (stage.activeBreakCount() === 1 && me.jumpsLeft > 0) || this.pressureNow(snap) >= 0.5;
    let sp = this.smashPlan;
    if (sp) {
      const P = stage.plats[sp.plat];
      if (!P.active || snap.frame > sp.until) {
        this.smashPlan = null;
        this.smashNext = snap.frame + 20 + Math.floor(this.rng() * 40);
        return false;
      }
      if (P.hp !== sp.hp) {
        // a hit counted (ours or not): keep going on the same piece (re-plan the stance), no new roll
        this.smashPlan = sp = this.makeSmashPlan(me, mi, t, snap, sp.plat, desperate);
        if (!sp) return false;
      }
    } else {
      if (snap.frame < this.smashNext) return false;
      this.smashNext = snap.frame + 50 + Math.floor(this.rng() * 90);
      if (this.rng() >= this.smashAppetite) return false;
      this.smashPlan = sp = this.makeSmashPlan(me, mi, t, snap, -1, desperate);
      if (!sp) return false;
    }
    const P = stage.plats[sp.plat];
    if (sp.id === null) {
      // go stand on the piece
      if (me.platformId === P.id) {
        this.smashPlan = null;
        this.smashNext = 0;
        return false;
      }
      if (!sp.jab && this.hopToward(me, sp.plat, snap)) {
        this.mode = 'smash-go';
        return true;
      }
      // cannot stand on it (out of reach of the graph): jump under it and hit it from below
      if (!sp.jab) {
        sp.jab = true;
        sp.until = Math.min(sp.until, snap.frame + 240);
      }
      stage.runSpan(mi, this.span);
      const jlo = Math.max(P.x0 + 0.8, this.span.lo + 0.5);
      const jhi = Math.min(P.x1 - 0.8, this.span.hi - 0.5);
      if (jlo > jhi || P.y - me.pos.y > 6.5) {
        // not above the floor we stand on: nothing to jab from here
        this.smashPlan = null;
        this.smashNext = snap.frame + 150;
        return false;
      }
      const gx = clamp(me.pos.x, jlo, jhi);
      const gdx = gx - me.pos.x;
      if (Math.abs(gdx) > 0.45) {
        this.mode = 'smash-walk';
        c.moveY = 0;
        c.moveX = sgn(gdx) * (Math.abs(gdx) > 1.2 ? 1 : 0.5);
        return true;
      }
      if (snap.frame >= this.jabUntil) {
        this.jabPlat = sp.plat;
        this.jabUntil = snap.frame + 75;
        this.doJump(snap.frame, 0);
        this.mode = 'smash-jump';
        return true;
      }
      return false;
    }
    const dx = sp.x - me.pos.x;
    if (Math.abs(dx) > 0.3) {
      this.mode = 'smash-walk';
      c.moveY = 0;
      // the stance is always inside the floor we stand on (>= 0.5 m from its ends), so no edge check
      c.moveX = sgn(dx) * (Math.abs(dx) > 1.2 ? 1 : 0.5);
      return true;
    }
    this.mode = 'smash:' + sp.id;
    this.pressCand(me, { id: sp.id, air: false, dir: sp.dir, score: 1, frame: 0, kill: false });
    return true;
  }

  /** Pick the piece to smash (`want` >= 0: keep that one) and where to stand / which move to use. Null when nothing sensible. */
  private makeSmashPlan(me: BrawlFighterState, mi: number, t: Opp, snap: BrawlSnapshot, want: number, desperate: boolean): SmashPlan | null {
    const stage = this.stage as StageInfo;
    const animal = this.animal as AnimalId;
    const stats = this.stats;
    const jumpH = (stats.jumpVel * stats.jumpVel) / (2 * GRAV * stats.gravityMult);
    const airH = ((stats.airJumpVel * stats.airJumpVel) / (2 * GRAV * stats.gravityMult)) * (stats.maxJumps - 1);
    const reach = jumpH + airH - 0.4;
    stage.runSpan(mi, this.span);
    const runLo = this.span.lo;
    const runHi = this.span.hi;
    const mp = stage.plats[mi];
    let best: SmashPlan | null = null;
    let bestCost = Infinity;
    // top-down: the soft arches / crown first (they are only reachable from the floors below them), the floors last
    let softRemain = false;
    for (const j of stage.breakIdx) if (stage.plats[j].active && !stage.plats[j].solid) softRemain = true;
    for (let n = 0; n < stage.breakIdx.length; n++) {
      const j = stage.breakIdx[n];
      if (want >= 0 && j !== want) continue;
      const P = stage.plats[j];
      if (!P.active || P.hp <= 0) continue;
      let lo: number;
      let hi: number;
      let standY = mp.y;
      if (P.solid) {
        // from the floor we stand on: the piece must belong to our walkable run
        if (Math.abs(P.y - mp.y) > 0.12 || P.x1 < runLo - 0.1 || P.x0 > runHi + 0.1) continue;
        if (j === mi && P.hp <= 2 && !desperate) continue;
        lo = runLo + 0.5;
        hi = runHi - 0.5;
      } else {
        // a soft piece: stand on it; it must be within jump reach (or below us)
        if (P.y - me.pos.y > reach + 2.2) continue;
        if (!desperate && stage.platformBelow((P.x0 + P.x1) * 0.5, P.y - 0.4, stats.width, 0) < 0 && P.hp <= 1) continue;
        if (me.platformId !== P.id) {
          const goCost = Math.abs((P.x0 + P.x1) * 0.5 - me.pos.x) * 0.6 + Math.abs(P.y - me.pos.y) * 1.2 + 4 - P.y * 1.5;
          if (goCost < bestCost) {
            bestCost = goCost;
            best = { plat: j, hp: P.hp, x: me.pos.x, id: null, dir: 1, until: snap.frame + 420 };
          }
          continue;
        }
        standY = P.y;
        lo = P.x0 + 0.5;
        hi = P.x1 - 0.5;
      }
      if (lo > hi) continue;
      for (let x = lo; x <= hi + 1e-6; x += 0.5) {
        // the floor under the stance must not be (or be about to become) the piece that breaks
        const sup = stage.platformBelow(x, standY, stats.width, 0.05);
        if (sup < 0) continue;
        if (sup === j && P.solid && P.hp <= 2 && !desperate) continue;
        for (const id of GROUND_IDS) {
          if (id === 'heavyU' || MOVESETS[animal].moves[id].airOnly) continue;
          const info = moveInfo(animal, id, false, 0);
          if (info.travelX > 0.5 || info.stopsAtEdge || info.burrow) continue;
          for (const face of [1, -1] as const) {
            if (this.hitsPlatform(info, x, standY, face, P) < 0) continue;
            // never also break the nearly broken floor under our own feet
            let unsafe = false;
            for (let m = 0; m < stage.breakIdx.length && !unsafe; m++) {
              const q = stage.plats[stage.breakIdx[m]];
              if (q === P || !q.active || q.hp > 2) continue;
              if (desperate && q.hp > 0 && stage.activeBreakCount() <= 2) continue;
              if ((stage.breakIdx[m] === mi || stage.breakIdx[m] === sup) && this.hitsPlatform(info, x, standY, face, q) >= 0) unsafe = true;
            }
            if (unsafe) continue;
            const cost = Math.abs(x - me.pos.x) * 9 + info.first + info.endlag * 0.4 + (face !== me.facing ? 5 : 0) + (P.solid ? (softRemain ? 16 : 0) : -3 - P.y * 1.5) - (t.dist > 8 ? 0 : 4);
            if (cost < bestCost) {
              bestCost = cost;
              best = { plat: j, hp: P.hp, x, id, dir: face, until: snap.frame + 420 };
            }
          }
        }
      }
    }
    return best;
  }

  // ── v1.6 platform graph (dynamic stages) ─────────────────────────────────

  /** Walkable runs of the ACTIVE platforms: touching platforms at one height are one floor. */
  private buildRuns(): void {
    const stage = this.stage as StageInfo;
    const pl = stage.plats;
    const n = pl.length;
    this.runOf.length = n;
    this.runOf.fill(-1);
    let r = 0;
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!pl[i].active || this.runOf[i] >= 0) continue;
      let lo = pl[i].x0;
      let hi = pl[i].x1;
      this.runOf[i] = r;
      stack.length = 0;
      stack.push(i);
      while (stack.length > 0) {
        const j = stack.pop() as number;
        for (let k = 0; k < n; k++) {
          const q = pl[k];
          if (this.runOf[k] >= 0 || !q.active || Math.abs(q.y - pl[j].y) > 0.12) continue;
          if (q.x1 < pl[j].x0 - 0.1 || q.x0 > pl[j].x1 + 0.1) continue;
          this.runOf[k] = r;
          lo = Math.min(lo, q.x0);
          hi = Math.max(hi, q.x1);
          stack.push(k);
        }
      }
      this.runLo[r] = lo;
      this.runHi[r] = hi;
      this.runY[r] = pl[i].y;
      r++;
    }
    this.runN = r;
  }

  /** The platform the opponent is (or is about to be) standing on, −1 when it is off the stage. */
  private goalPlat(t: Opp): number {
    const stage = this.stage as StageInfo;
    if (t.grounded) return stage.platIndex(t.s.platformId);
    if (t.hanging) return -1;
    return stage.platformBelow(t.x, t.y, t.w, 0.3);
  }

  /** Verified one-step hop from run `a` to run `b` for this animal (cached per ~16 frames), or null. */
  private hopEdge(a: number, b: number, snap: BrawlSnapshot): HopEdge | null {
    const stage = this.stage as StageInfo;
    const stamp = stage.version * 100000 + (snap.frame >> 4);
    if (stamp !== this.hopStamp) {
      this.hopCache.clear();
      this.hopStamp = stamp;
    }
    const key = a * 64 + b;
    const hit = this.hopCache.get(key);
    if (hit !== undefined) return hit;
    const e = this.computeHop(a, b);
    this.hopCache.set(key, e);
    return e;
  }

  private computeHop(a: number, b: number): HopEdge | null {
    const stage = this.stage as StageInfo;
    const st = this.stats;
    const env = this.recEnv as RecEnv;
    const aLo = this.runLo[a];
    const aHi = this.runHi[a];
    const bLo = this.runLo[b];
    const bHi = this.runHi[b];
    const yA = this.runY[a];
    const yB = this.runY[b];
    const jumpH = (st.jumpVel * st.jumpVel) / (2 * GRAV * st.gravityMult);
    const airH = ((st.airJumpVel * st.airJumpVel) / (2 * GRAV * st.gravityMult)) * (st.maxJumps - 1);
    const rise = yB - yA;
    if (rise > jumpH + airH + 0.3) return null;
    const gap = bLo > aHi ? bLo - aHi : aLo > bHi ? aLo - bHi : 0;
    if (gap > 9 || (rise < -9 && gap > 4)) return null;
    const dirB: 1 | -1 = bLo + bHi > aLo + aHi ? 1 : -1;
    const up = rise > 0.4;
    // a soft floor can be dropped through where the lower run lies straight under it
    let aSoft = true;
    for (let i = 0; i < stage.plats.length; i++) if (this.runOf[i] === a && stage.plats[i].solid) aSoft = false;
    const xs: number[] = [dirB > 0 ? aHi - 0.3 : aLo + 0.3];
    if (gap === 0) xs.push(clamp((Math.max(aLo, bLo) + Math.min(aHi, bHi)) * 0.5, aLo + 0.4, aHi - 0.4));
    for (const x of xs) {
      const edge = x === xs[0];
      const dir: 1 | -1 = gap > 0 || edge ? dirB : (bLo + bHi) * 0.5 >= x ? 1 : -1;
      const interiorDrop = !up && !edge && aSoft && gap === 0;
      if (!up && !edge && !aSoft) continue;
      const tx = bHi - bLo < 1.8 ? (bLo + bHi) * 0.5 : clamp(x + (gap > 0 ? dir * 2.5 : 0), bLo + 0.9, bHi - 0.9);
      const s0: RecState = {
        // a walk-off starts just past the end of the floor (inside the support tolerance the sim would land on it again at once)
        x: edge && !up ? (dir > 0 ? aHi + 0.45 : aLo - 0.45) : x,
        y: interiorDrop ? yA - 0.1 : edge && !up ? yA - 0.02 : yA,
        vx: up ? (edge ? dir * st.airSpeed * 0.5 : 0) : edge ? dir * st.runSpeed * 0.8 : 0,
        vy: up ? st.jumpVel : 0,
        jumps: st.maxJumps - 1,
        recoveryUsed: false,
        ledgeCd: 0,
        facing: dir,
        freeFall: false,
      };
      const jys = up ? [yB + 1.2, yB - 0.8] : [NEG_INF, yB + 1.2];
      for (const jy of jys) {
        const pol: RecPolicy = { tx, glide: st.glideFall !== undefined, jumpY: jy, heavyY: NEG_INF, heavyLast: true };
        const r = simRecovery(env, s0, pol, 150);
        if (!r.ok) continue;
        const landRun = r.kind === 'land' ? this.runOf[r.plat] : r.kind === 'ledge' ? this.runOf[stage.ledges[r.ledge].plat] : -1;
        if (landRun !== b) continue;
        let rep = -1;
        for (let i = 0; i < stage.plats.length; i++) {
          if (this.runOf[i] !== b) continue;
          if (rep < 0 || (tx >= stage.plats[i].x0 && tx <= stage.plats[i].x1)) rep = i;
        }
        return { to: rep, launchX: x, dir, kind: up ? 'jump' : interiorDrop ? 'drop' : 'walk', tx, jumpY: jy };
      }
    }
    return null;
  }

  /**
   * Route the bot over the platform graph to platform `goal` (breadth first over verified hops, at most 3 deep; when the goal cannot be
   * reached, to the reachable floor nearest to it). Walks to the launch point and starts the hop. Returns true when it set the stick.
   */
  private hopToward(me: BrawlFighterState, goal: number, snap: BrawlSnapshot, waitPressure = 0): boolean {
    if (!me.grounded || this.recEnv === null) return false;
    // a walk-off / drop that has started is committed (no back and forth around the launch point)
    if (snap.frame < this.hopCommitUntil) {
      this.cur.moveX = this.hopCommitX;
      this.cur.moveY = this.hopCommitY;
      this.mode = 'hop-walk';
      return true;
    }
    if (goal < 0) return false;
    const stage = this.stage as StageInfo;
    const mi = stage.platIndex(me.platformId);
    if (mi < 0) return false;
    this.buildRuns();
    const ra = this.runOf[mi];
    const rb = this.runOf[goal];
    if (ra < 0 || rb < 0 || ra === rb) return false;
    const n = this.runN;
    const prev: number[] = new Array<number>(n).fill(-2);
    const depth: number[] = new Array<number>(n).fill(0);
    const q: number[] = [ra];
    prev[ra] = -1;
    let found = false;
    for (let h = 0; h < q.length && !found; h++) {
      const r = q[h];
      if (depth[r] >= 3) continue;
      for (let k = 0; k < n; k++) {
        if (prev[k] !== -2) continue;
        if (!this.hopEdge(r, k, snap)) continue;
        prev[k] = r;
        depth[k] = depth[r] + 1;
        q.push(k);
        if (k === rb) {
          found = true;
          break;
        }
      }
    }
    let end = rb;
    if (!found) {
      // nearest reachable floor to the goal, if it brings us clearly closer
      const gx = (this.runLo[rb] + this.runHi[rb]) * 0.5;
      const dist = (r: number): number => Math.abs((this.runLo[r] + this.runHi[r]) * 0.5 - gx) * 0.5 + Math.abs(this.runY[r] - this.runY[rb]);
      let bd = dist(ra) - 1.5;
      end = -1;
      for (let i = 1; i < q.length; i++) {
        const d = dist(q[i]);
        if (d < bd) {
          bd = d;
          end = q[i];
        }
      }
      if (end < 0) return false;
    }
    // first hop of the path
    let step = end;
    while (prev[step] !== ra && prev[step] >= 0) step = prev[step];
    const e = this.hopEdge(ra, step, snap);
    if (!e) return false;
    // chasing an opponent over a gap: a strong bot lets it come first (the stall breaker `pressure` ends the standoff)
    if (waitPressure > 0 && e.kind !== 'jump' && this.pressureNow(snap) < waitPressure) return false;
    const c = this.cur;
    const dx = e.launchX - me.pos.x;
    if (Math.abs(dx) > 0.35) {
      c.moveX = sgn(dx) * (Math.abs(dx) > 1.2 ? 1 : 0.5);
      c.moveY = 0;
      this.mode = 'hop-go';
      return true;
    }
    this.crossGoal = e.to;
    this.crossUntil = snap.frame + 110;
    this.hopUntil = snap.frame + 110;
    this.hopTx = e.tx;
    this.hopJumpY = e.jumpY;
    if (e.kind === 'jump') {
      this.doJump(snap.frame, e.dir * 0.5);
      this.mode = 'hop-jump';
    } else if (e.kind === 'drop') {
      c.moveX = 0;
      c.moveY = -1;
      this.mode = 'hop-drop';
      this.hopCommitUntil = snap.frame + 12;
      this.hopCommitX = 0;
      this.hopCommitY = -1;
    } else {
      c.moveX = e.dir;
      c.moveY = 0;
      this.mode = 'hop-walk';
      this.hopCommitUntil = snap.frame + 25;
      this.hopCommitX = e.dir;
      this.hopCommitY = 0;
    }
    return true;
  }

  /** Airborne under a breakable piece: press the aerial that will overlap it by the time it starts (the piece is hit from below). */
  private jabAttack(me: BrawlFighterState): boolean {
    const stage = this.stage as StageInfo;
    const P = stage.plats[this.jabPlat];
    if (!P || !P.active || P.hp <= 0 || this.animal === null) {
      this.jabUntil = 0;
      return false;
    }
    const gm = this.stats.gravityMult;
    let bestId: MoveId | null = null;
    let bestFace: 1 | -1 = me.facing;
    let bestFirst = 99;
    for (const id of AIR_IDS) {
      if (MOVESETS[this.animal].moves[id].groundOnly) continue;
      const info = moveInfo(this.animal, id, true, 0);
      const t = info.first / 60;
      const y = me.pos.y + me.vel.y * t - 0.5 * GRAV * gm * t * t;
      const x = me.pos.x + me.vel.x * t * 0.9;
      for (const face of id.endsWith('S') ? ([me.facing, -me.facing] as (1 | -1)[]) : ([me.facing] as (1 | -1)[])) {
        if (this.hitsPlatform(info, x, y, face, P) < 0) continue;
        // never also hit a nearly broken floor we are about to land on
        if (info.first < bestFirst) {
          bestFirst = info.first;
          bestId = id;
          bestFace = face;
        }
      }
    }
    if (bestId === null) return false;
    this.mode = 'smash-jab:' + bestId;
    this.jabUntil = 0;
    this.pressCand(me, { id: bestId, air: true, dir: bestFace, score: 1, frame: 0, kill: false });
    return true;
  }

  /** Level 3+ on a breakable arena: after 35-60 s without any exchange (the longer the better its position) the bot walks off its floor and does not recover. */
  private stalemateDive(me: BrawlFighterState, t: Opp, snap: BrawlSnapshot): boolean {
    const stage = this.stage as StageInfo;
    if (snap.frame < this.diveUntil) {
      this.mode = 'dive';
      this.cur.moveX = this.diveDir;
      this.cur.moveY = 0;
      return true;
    }
    if (this.lp.level < 3 || me.stocks < 2 || !me.grounded) return false;
    if (stage.activeBreakCount() === 0) return false;
    // not ahead: 35 s; far ahead (2+ stocks): 45 s; a narrow lead only waits a little longer (60 s) - the clock must not decide a standoff
    const ahead = me.stocks > t.s.stocks || (me.stocks === t.s.stocks && me.percent < t.s.percent);
    const wait = !ahead ? 2100 : me.stocks - t.s.stocks >= 2 ? 2700 : 3600;
    if (snap.frame - this.lastAny < wait) return false;
    const mi = stage.platIndex(me.platformId);
    if (mi < 0) return false;
    this.buildRuns();
    const goal = this.goalPlat(t);
    if (goal >= 0 && this.runOf[goal] === this.runOf[mi]) return false;
    // the edge towards the middle of the arena
    this.diveDir = me.pos.x > stage.centerX ? -1 : 1;
    this.diveUntil = snap.frame + 400;
    this.mode = 'dive';
    this.cur.moveX = this.diveDir;
    this.cur.moveY = 0;
    return true;
  }

  /** Standing still for a long time with nothing to do: walk to another spot of the same floor (the streak ends, the situation changes). */
  private stillBored(me: BrawlFighterState, snap: BrawlSnapshot): boolean {
    const still = snap.frame - this.stillSince;
    if (still < 200 && snap.frame >= this.boredUntil) return false;
    const stage = this.stage as StageInfo;
    const mi = stage.platIndex(me.platformId);
    if (mi < 0) return false;
    if (snap.frame >= this.boredUntil || !Number.isFinite(this.boredTx)) {
      stage.runSpan(mi, this.span);
      const lo = this.span.lo + 1.0;
      const hi = this.span.hi - 1.0;
      if (lo >= hi) return false;
      // the farther end of the floor (always well inside it, so no edge check is needed)
      const far = me.pos.x - lo > hi - me.pos.x ? lo : hi;
      this.boredTx = far;
      this.boredUntil = snap.frame + 150;
    }
    const d = this.boredTx - me.pos.x;
    if (Math.abs(d) < 0.5) {
      this.boredUntil = 0;
      this.boredTx = NaN;
      return false;
    }
    this.mode = 'bored';
    this.cur.moveX = sgn(d);
    this.cur.moveY = 0;
    return true;
  }

  // ── airborne (not recovering) ───────────────────────────────────────────

  private doAir(me: BrawlFighterState, snap: BrawlSnapshot): void {
    const c = this.cur;
    const lp = this.lp;
    const stage = this.stage as StageInfo;
    this.plan = null;
    this.ledgePlan = null;
    const tgt = this.pickTarget();
    this.mode = 'air';
    c.moveY = 0;
    if (!tgt) {
      c.moveX = clamp((stage.centerX - me.pos.x) * 0.3, -1, 1);
      return;
    }
    if (lp.engine === 0) {
      c.moveX = sgn(tgt.dx) * 0.8;
      if (tgt.dist < 2.2 && snap.frame >= this.mashAt) {
        this.press('light', 0, 0);
        this.mashAt = snap.frame + 8 + Math.floor(this.rng() * 8);
      }
      return;
    }
    const thr = this.worstThreat(me);
    if (thr && lp.level >= 3 && !me.airDodgeUsed && me.dodgeCd <= 0 && this.safeForAirDodge(me) && this.shouldDodge(me, thr) && this.rng() < 0.5) {
      c.dodge = true;
      c.moveX = 0;
      c.moveY = 0;
      this.mode = 'airdodge';
      return;
    }
    if (snap.frame < this.jabUntil && this.jabPlat >= 0 && tgt.dist > 4.6) {
      if (this.jabAttack(me)) return;
      // not high enough yet: spend the air jump at the top of the first jump
      const jp = (this.stage as StageInfo).plats[this.jabPlat];
      if (jp && me.jumpsLeft > 0 && me.vel.y <= 1.5 && me.pos.y < jp.y - 0.4 && !me.freeFall) {
        c.jump = true;
        c.jumpHeld = true;
        this.jumpHoldUntil = snap.frame + 10;
        this.mode = 'smash-jump';
        return;
      }
    }
    const cand = this.bestAttack(me, tgt, true, snap, thr);
    if (cand) {
      this.mode = 'air:' + cand.id;
      this.pressCand(me, cand);
      return;
    }
    // drift toward the target, but never off the stage unless it is safe
    let mx = clamp(tgt.dx * 0.6, -1, 1);
    if (Math.abs(tgt.dx) < 0.8) mx = 0;
    if (snap.frame < this.hopUntil && Number.isFinite(this.hopTx)) {
      // a verified hop is in flight: steer onto the landing floor and spend the air jump where the plan did
      mx = steerTo(me.pos.x, me.vel.x, this.hopTx, this.stats.airSpeed);
      if (me.jumpsLeft > 0 && me.vel.y <= 1.0 && me.pos.y <= this.hopJumpY && !me.freeFall) {
        c.jump = true;
        c.jumpHeld = true;
        this.jumpHoldUntil = snap.frame + 10;
      }
      this.mode = 'hop-air';
    } else if (snap.frame < this.crossUntil && this.crossGoal >= 0) mx = sgn(tgt.dx);
    else if (lp.edgeSafe > this.rng()) {
      const nextX = me.pos.x + me.vel.x * 0.25 + mx * 1.2;
      if (stage.platformBelow(nextX, me.pos.y, this.stats.width, 0.3) < 0 && stage.platformBelow(me.pos.x, me.pos.y, this.stats.width, 0.3) >= 0) {
        const L = stage.nearestLedge(me.pos.x, me.pos.y);
        mx = L ? sgn(L.x - L.side * 2 - me.pos.x) * 0.7 : 0;
      }
    }
    c.moveX = mx;
    // let the Eagle glide while it approaches
    if (this.stats.glideFall !== undefined) c.jumpHeld = tgt.dy < 1;
    // fast fall onto an opponent standing below
    if (lp.level >= 3 && tgt.dy < -1 && tgt.dist < 1.5 && me.vel.y <= 0) c.moveY = -1;
  }

  private safeForAirDodge(me: BrawlFighterState): boolean {
    const stage = this.stage as StageInfo;
    const i = stage.platformBelow(me.pos.x, me.pos.y, this.stats.width, 0.3);
    if (i < 0) return false;
    return me.pos.y - stage.plats[i].y < 5.5;
  }
}
