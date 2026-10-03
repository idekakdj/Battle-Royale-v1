/**
 * Internal mutable fighter used by `BrawlWorld`. Carries everything in `BrawlFighterState`
 * plus the simulation-only bookkeeping (input buffers, move registry, ledge/dodge/respawn timers).
 * `toState()` produces a fresh, independent public snapshot object.
 */

import type { AnimalId } from '../../core/types';
import type { BrawlAction, BrawlFighterState, CharacterStats, Facing, MoveBody, MoveId, MovePhase, MovesetDef, V2 } from '../types';

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
