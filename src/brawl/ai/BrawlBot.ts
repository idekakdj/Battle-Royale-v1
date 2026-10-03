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
import { animalInfo, moveInfo, probeHit } from './moveInfo';
import type { AnimalInfo, MoveInfo } from './moveInfo';
import { StageInfo, stageFromSnapshot, supportedBy } from './stageInfo';
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
    stage.sync(snap.platforms);
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

  private trackExchange(snap: BrawlSnapshot, me: BrawlFighterState): void {
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
    // drop toward an island/stage the opponents are not standing on
    let tx = stage.centerX;
    if (!stage.overSolid(me.pos.x, -1)) {
      let bestD = Infinity;
      for (const p of stage.plats) {
        if (!p.solid) continue;
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
      const sp = ledgeSpot(L.x, L.side, p.y, st);
      tgts.push({ kind: 'ledge', tx: sp.x, ty: sp.y, ledge: i, plat: L.plat, d: Math.hypot(sp.x - s0.x, (sp.y - s0.y) * 1.3) + (this.crossGoal >= 0 && L.plat !== this.crossGoal ? 8 : 0) + (this.lastThinkFrame < this.preferLandUntil ? 7 : 0) });
    }
    for (let i = 0; i < stage.plats.length; i++) {
      const p = stage.plats[i];
      if (p.y < s0.y - 0.3) continue;
      const lo = p.x0 + 0.9;
      const hi = p.x1 - 0.9;
      const tx = lo <= hi ? clamp(s0.x, lo, hi) : (p.x0 + p.x1) * 0.5;
      tgts.push({ kind: 'land', tx, ty: p.y, ledge: -1, plat: i, d: Math.hypot(tx - s0.x, (p.y - s0.y) * 1.3) + 1.5 + (this.crossGoal >= 0 && i !== this.crossGoal ? 8 : 0) });
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
    const pressure = clamp((snap.frame - this.lastExchange) / 900, 0, 1);
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
      const pr = probeHit(info, relX, relY, o.w, o.h, rvx, rvy, m.ay);
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
      const risk = (1 - P) * endlag * 0.2 + extraRisk;
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
    for (let mf = 0; mf < info.total; mf++) {
      let g = 1;
      let setX = false;
      let setY = false;
      if (body.motion) {
        for (const m of body.motion) {
          if (mf < m.from || mf >= m.to) continue;
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
        if (vy > 0) grounded = false;
      } else if (!setX) vx *= 0.985;
      if (!grounded) {
        vy -= GRAV * st.gravityMult * g * (1 / 60);
        if (!setY && vy < -st.fallSpeed) vy = -st.fallSpeed;
      }
      const ox = x;
      const oy = y;
      x += vx * (1 / 60);
      if (!grounded) {
        y += vy * (1 / 60);
        if (vy < 0) {
          for (const p of stage.plats) {
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
    const pressure = clamp((snap.frame - this.lastExchange) / 900, 0, 1);

    // vertical separation: different tier
    const myPlat = stage.platIndex(me.platformId);
    if (lp.stagePlay || lp.engine === 1) {
      if (this.navigateTiers(me, t, myPlat, snap)) return;
    }

    // edge-guard: the opponent is off the stage — stand at the ledge it must reach
    if (lp.edgeGuard && (t.offstage || t.hanging) && this.guardLedge(me, t)) return;

    // the opponent is on another island: cross the gap (Sky Aqueduct)
    if (lp.engine >= 1 && this.tryCross(me, t, snap, pressure)) return;

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
      if (p.solid && t.x > p.x0 - 0.5 && t.x < p.x1 + 0.5) {
        ti = i;
        break;
      }
    }
    if (ti < 0 || ti === si) return false;
    const S = stage.plats[si];
    const T = stage.plats[ti];
    const dir: 1 | -1 = T.x0 + T.x1 > S.x0 + S.x1 ? 1 : -1;
    const edge = dir > 0 ? S.x1 : S.x0;
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
    const cand = this.bestAttack(me, tgt, true, snap, thr);
    if (cand) {
      this.mode = 'air:' + cand.id;
      this.pressCand(me, cand);
      return;
    }
    // drift toward the target, but never off the stage unless it is safe
    let mx = clamp(tgt.dx * 0.6, -1, 1);
    if (Math.abs(tgt.dx) < 0.8) mx = 0;
    if (snap.frame < this.crossUntil && this.crossGoal >= 0) mx = sgn(tgt.dx);
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
