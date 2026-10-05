/**
 * Internal mutable fighter used by `BrawlWorld`. Carries everything in `BrawlFighterState`
 * plus the simulation-only bookkeeping (input buffers, move registry, ledge/dodge/respawn timers).
 * `toState()` produces a fresh, independent public snapshot object.
 */

import type { AnimalId } from '../../core/types';
import type { BrawlAction, BrawlFighterState, CharacterStats, Facing, MoveBody, MoveId, MovePhase, MovesetDef, V2 } from '../types';
import type { StateIO } from './stateIO';

/** "No buffered press". */
export const NO_BUF = -1;

export class Fighter {
  readonly id: number;
  readonly animal: AnimalId;
  readonly isPlayer: boolean;
  readonly moveset: MovesetDef;
  readonly stats: CharacterStats;

  // ── public state ────────────────────────────────────────────────────────
  alive = true;
  pos: V2 = { x: 0, y: 0 };
  vel: V2 = { x: 0, y: 0 };
  facing: Facing = 1;
  grounded = false;
  /** Index of the platform stood on / hung from (−1 = none). */
  platIdx = -1;
  action: BrawlAction = 'idle';
  actionFrame = 0;
  actionFrames = 0;
  moveId: MoveId | null = null;
  moveChain = 0;
  moveAir = false;
  moveFrame = 0;
  moveFrames = 0;
  movePhase: MovePhase | null = null;
  dodgeCd = 0;
  hitstunTotal = 0;
  lastHitBy = -1;
  percent = 0;
  stocks: number;
  jumpsLeft: number;
  hitstun = 0;
  hitlag = 0;
  invuln = 0;
  lastLaunch: { angle: number; speed: number } | null = null;
  kos = 0;
  falls = 0;
  damageDealt = 0;

  // ── move bookkeeping ────────────────────────────────────────────────────
  /** Effective body of the current move (null outside attacks). */
  body: MoveBody | null = null;
  /** Last move frame each (hitbox group × victim) connected on (−1 = never). Stride = fighter count. */
  hitReg: number[] = [];
  armorLeft = 0;
  /** The current body has connected (cancel windows `onHitOnly`). */
  moveConnected = false;
  /** Staling queue push already done for this activation / string. */
  movePushed = false;
  /** Last ≤ 6 connected MoveIds (staling). */
  staleQueue: MoveId[] = [];
  /** Heavy-Up (recovery) spent this airtime. */
  recoveryUsed = false;

  // ── input ───────────────────────────────────────────────────────────────
  inX = 0;
  inY = 0;
  inJumpHeld = false;
  pendJump = false;
  pendLight = false;
  pendHeavy = false;
  pendDodge = false;
  /** Age (frames since the press) of each buffered press, or NO_BUF. */
  bufJump = NO_BUF;
  bufLight = NO_BUF;
  bufHeavy = NO_BUF;
  bufDodge = NO_BUF;
  /** Direction held at the moment of the press. */
  lightDx = 0;
  lightDy = 0;
  heavyDx = 0;
  heavyDy = 0;
  dodgeDx = 0;
  dodgeDy = 0;

  // ── movement flags ──────────────────────────────────────────────────────
  freeFall = false;
  airDodgeUsed = false;
  fastFalling = false;
  groundedFrames = 0;
  dropPlat = -1;
  dropTimer = 0;
  /** Short-hop tracking. */
  jumpWasHeld = false;
  jumpReleased = false;
  hopWindow = 0;
  hopCut = false;
  /** Hitstun bookkeeping. */
  pendingTumble = false;
  diUsed = 0;
  lastHitFrame = -100000;
  /** Dodge / ledge / respawn. */
  dodgeDir = 0;
  ledgeIdx = -1;
  ledgeRegrab = 0;
  grabFrames: number[] = [];
  climbRoll = false;
  climbFromX = 0;
  climbFromY = 0;
  /** Frames left out of the match before respawning. */
  respawnIn = 0;

  constructor(id: number, animal: AnimalId, isPlayer: boolean, moveset: MovesetDef, stocks: number) {
    this.id = id;
    this.animal = animal;
    this.isPlayer = isPlayer;
    this.moveset = moveset;
    this.stats = moveset.stats;
    this.stocks = stocks;
    this.jumpsLeft = moveset.stats.maxJumps;
  }

  /**
   * Save / load / checksum of every MUTABLE field except `body` (a shared registry object, saved by reference by the
   * world). The order below is the canonical checksum order — appending a field here is all a new sim field needs
   * (tests/brawl/determinism.state.test.ts fails if a field of this class is neither listed here nor immutable).
   */
  sync(io: StateIO): void {
    this.alive = io.b(this.alive);
    this.pos.x = io.n(this.pos.x);
    this.pos.y = io.n(this.pos.y);
    this.vel.x = io.n(this.vel.x);
    this.vel.y = io.n(this.vel.y);
    this.facing = io.n(this.facing) as Facing;
    this.grounded = io.b(this.grounded);
    this.platIdx = io.n(this.platIdx);
    this.action = io.action(this.action);
    this.actionFrame = io.n(this.actionFrame);
    this.actionFrames = io.n(this.actionFrames);
    this.moveId = io.moveId(this.moveId);
    this.moveChain = io.n(this.moveChain);
    this.moveAir = io.b(this.moveAir);
    this.moveFrame = io.n(this.moveFrame);
    this.moveFrames = io.n(this.moveFrames);
    this.movePhase = io.phase(this.movePhase);
    this.dodgeCd = io.n(this.dodgeCd);
    this.hitstunTotal = io.n(this.hitstunTotal);
    this.lastHitBy = io.n(this.lastHitBy);
    this.percent = io.n(this.percent);
    this.stocks = io.n(this.stocks);
    this.jumpsLeft = io.n(this.jumpsLeft);
    this.hitstun = io.n(this.hitstun);
    this.hitlag = io.n(this.hitlag);
    this.invuln = io.n(this.invuln);
    this.lastLaunch = io.launch(this.lastLaunch);
    this.kos = io.n(this.kos);
    this.falls = io.n(this.falls);
    this.damageDealt = io.n(this.damageDealt);
    this.hitReg = io.nums(this.hitReg);
    this.armorLeft = io.n(this.armorLeft);
    this.moveConnected = io.b(this.moveConnected);
    this.movePushed = io.b(this.movePushed);
    this.staleQueue = io.moveIds(this.staleQueue);
    this.recoveryUsed = io.b(this.recoveryUsed);
    this.inX = io.n(this.inX);
    this.inY = io.n(this.inY);
    this.inJumpHeld = io.b(this.inJumpHeld);
    this.pendJump = io.b(this.pendJump);
    this.pendLight = io.b(this.pendLight);
    this.pendHeavy = io.b(this.pendHeavy);
    this.pendDodge = io.b(this.pendDodge);
    this.bufJump = io.n(this.bufJump);
    this.bufLight = io.n(this.bufLight);
    this.bufHeavy = io.n(this.bufHeavy);
    this.bufDodge = io.n(this.bufDodge);
    this.lightDx = io.n(this.lightDx);
    this.lightDy = io.n(this.lightDy);
    this.heavyDx = io.n(this.heavyDx);
    this.heavyDy = io.n(this.heavyDy);
    this.dodgeDx = io.n(this.dodgeDx);
    this.dodgeDy = io.n(this.dodgeDy);
    this.freeFall = io.b(this.freeFall);
    this.airDodgeUsed = io.b(this.airDodgeUsed);
    this.fastFalling = io.b(this.fastFalling);
    this.groundedFrames = io.n(this.groundedFrames);
    this.dropPlat = io.n(this.dropPlat);
    this.dropTimer = io.n(this.dropTimer);
    this.jumpWasHeld = io.b(this.jumpWasHeld);
    this.jumpReleased = io.b(this.jumpReleased);
    this.hopWindow = io.n(this.hopWindow);
    this.hopCut = io.b(this.hopCut);
    this.pendingTumble = io.b(this.pendingTumble);
    this.diUsed = io.n(this.diUsed);
    this.lastHitFrame = io.n(this.lastHitFrame);
    this.dodgeDir = io.n(this.dodgeDir);
    this.ledgeIdx = io.n(this.ledgeIdx);
    this.ledgeRegrab = io.n(this.ledgeRegrab);
    this.grabFrames = io.nums(this.grabFrames);
    this.climbRoll = io.b(this.climbRoll);
    this.climbFromX = io.n(this.climbFromX);
    this.climbFromY = io.n(this.climbFromY);
    this.respawnIn = io.n(this.respawnIn);
  }

  /** A fresh, independent public snapshot of this fighter. */
  toState(platformId: string | null): BrawlFighterState {
    return {
      id: this.id,
      animal: this.animal,
      isPlayer: this.isPlayer,
      alive: this.alive,
      pos: { x: this.pos.x, y: this.pos.y },
      vel: { x: this.vel.x, y: this.vel.y },
      facing: this.facing,
      grounded: this.grounded,
      platformId,
      action: this.action,
      actionFrame: this.actionFrame,
      actionFrames: this.actionFrames,
      moveId: this.moveId,
      moveChain: this.moveChain,
      moveAir: this.moveAir,
      moveFrame: this.moveFrame,
      moveFrames: this.moveFrames,
      movePhase: this.movePhase,
      dodgeCd: this.dodgeCd,
      hitstunTotal: this.hitstunTotal,
      lastHitBy: this.lastHitBy,
      percent: this.percent,
      stocks: this.stocks,
      jumpsLeft: this.jumpsLeft,
      hitstun: this.hitstun,
      hitlag: this.hitlag,
      invuln: this.invuln,
      lastLaunch: this.lastLaunch ? { angle: this.lastLaunch.angle, speed: this.lastLaunch.speed } : null,
      kos: this.kos,
      falls: this.falls,
      damageDealt: this.damageDealt,
      recoveryUsed: this.recoveryUsed,
      airDodgeUsed: this.airDodgeUsed,
      freeFall: this.freeFall,
      ledgeCd: this.ledgeRegrab,
    };
  }
}
