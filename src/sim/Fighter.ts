/**
 * Fighter — the per-combatant state container (BLUEPRINT §5.1 {@link FighterState}
 * plus sim-internal fields the public snapshot never exposes). Also declares the
 * shared {@link Sim} context and {@link AbilityRuntime} that every system reads.
 *
 * This file is pure data + tiny mutators; combat/movement/ability LOGIC lives in
 * the system modules so responsibilities stay separable (BLUEPRINT §14 WP-B).
 */

import type { AnimalId, FighterIntent, FighterState, GameEvent, Vec3 } from '../core/types';
import type { AnimalDef, AbilitySpec } from '../config/animals';
import type { Obstacle } from '../config/arena';
import type { EventBus } from '../core/EventBus';
import type { Rng } from '../core/math';
import { MOVE } from '../config/balance';

/** A neutral, do-nothing intent (used before any intent is set). */
export function neutralIntent(): FighterIntent {
  return { moveX: 0, moveZ: 0, aimYaw: 0, attack: false, block: false, special: false, ultimate: false, jump: false };
}

/** Destructible crate runtime (config geometry + live hp). */
export interface CrateRuntime {
  id: number;
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  height: number;
  hp: number;
  alive: boolean;
}

/** Ability phase tags. */
export enum AbilityPhase {
  Windup = 0,
  Active = 1,
  Recovery = 2,
}

/**
 * Live special/ultimate state. Allocated once per cast (not a per-tick hot path)
 * and mutated in place while the ability runs.
 */
export interface AbilityRuntime {
  kind: 'special' | 'ultimate';
  spec: AbilitySpec;
  phase: AbilityPhase;
  t: number; // seconds elapsed in the current phase
  px: number; // aim / dive ground point x
  pz: number; // aim / dive ground point z
  sx: number; // leap/dash start point x
  sz: number; // leap/dash start point z
  dirX: number; // charge/dash unit direction x
  dirZ: number; // charge/dash unit direction z
  hitOnce: Set<number>; // per-target dedupe (charges/sweeps)
  counter: number; // generic counter (guillotine sweep index, etc.)
  accum: number; // generic accumulator (grab dps carry, elapsed damage)
  didHit: boolean; // grab/dive connected
  targetId: number; // grab target id (-1 none)
  isGrab: boolean; // true for croc/python grab ults (resist interruption)
}

/**
 * The mutable world context handed to every system. Kept intentionally small:
 * systems read fighters/geometry and route all mutations through these methods
 * so World stays the single owner of hp/death/event bookkeeping.
 */
export interface Sim {
  readonly fighters: Fighter[];
  readonly crates: CrateRuntime[];
  readonly staticObstacles: readonly Obstacle[];
  readonly bus: EventBus;
  readonly rng: Rng;
  time: number;
  bloodlustMult: number;
  emit(ev: GameEvent): void;
  /** Subtract `amount` hp from target, credit attacker, update stats. */
  dealHp(attacker: Fighter | null, target: Fighter, amount: number): void;
  /** Unblockable damage-over-time tick (bleed); credits `source`. */
  applyBleedDamage(source: Fighter, target: Fighter, amount: number): void;
  /** Damage a crate; emits crateBreak when destroyed. */
  damageCrate(crate: CrateRuntime, amount: number): void;
}

function makeState(id: number, animal: AnimalId, def: AnimalDef, isPlayer: boolean, pos: Vec3, yaw: number): FighterState {
  return {
    id,
    animal,
    isPlayer,
    alive: true,
    pos,
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    hp: def.hp,
    maxHp: def.hp,
    guard: def.guardMax,
    maxGuard: def.guardMax,
    guardRegenDelay: 0,
    ultCharge: 0,
    specialCd: 0,
    action: 'idle',
    actionT: 0,
    actionDur: 0,
    comboIndex: 0,
    comboWindow: 0,
    buffs: [],
    kills: 0,
    damageDealt: 0,
    damageBlocked: 0,
    ultsUsed: 0,
    grabTargetId: -1,
    grabbedById: -1,
    airborne: false,
    glideT: 0,
    burrowT: 0,
  };
}

export class Fighter {
  readonly id: number;
  readonly def: AnimalDef;
  readonly state: FighterState;
  intent: FighterIntent = neutralIntent();

  // Edge detection (attack/special/ultimate are edges; jump-start is an edge).
  private prevAttack = false;
  private prevSpecial = false;
  private prevUlt = false;
  private prevJump = false;
  edgeAttack = false;
  edgeSpecial = false;
  edgeUlt = false;
  edgeJump = false;

  // Swing / combo.
  swinging = false;
  hasHitThisSwing = false;
  chainQueued = false;
  sinceSwingEnd = 999;
  nextComboStep: 0 | 1 | 2 = 0;
  comboResetTimer = 0;

  // Block.
  blocking = false;
  prevBlocking = false;
  blockStartTime = -999;
  lastBlockedHitTime = -999;
  pythonTension = false;
  guardBreakRefillPending = false;

  // Hard-CC timers (seconds remaining).
  staggerTimer = 0;
  knockdownTimer = 0;
  hitstunTimer = 0;
  fearTimer = 0;
  rootTimer = 0;
  disarmTimer = 0;
  fearSourceX = 0;
  fearSourceZ = 0;

  // Knockback impulse.
  knockVX = 0;
  knockVZ = 0;
  knockTimer = 0;
  /** Rhino Lockdown flag: this fighter is a carried target this tick. */
  carriedBy = -1;

  // Bleed credit.
  bleedSourceId = -1;

  // Phase flags.
  untargetable = false;
  ccImmune = false;
  incomingDamageReduction = 0; // grabber's reduced damage taken (croc 0.5 / python 0.3)

  // Ability.
  ability: AbilityRuntime | null = null;

  // Eagle glide (separate cooldown from the Shift special).
  glideCd = 0;

  // Croc Ambush Lunge follow-up window.
  ambushBonusTimer = 0;

  // Panther Night Prowl: next attack from stealth is a bonus crit.
  stealthCritPending = false;

  // Gorilla Primal Rampage: basic hits knock back this many metres (0 when off).
  rampageKnockback = 0;
  // Gorilla Primal Rampage: remaining seconds of the buff window (drives ccImmune).
  rampageTimer = 0;
  // Channel CC-immunity from an active ult (rhino Stampede). OR'd with rampage.
  ccImmuneChannel = false;

  // Kill credit (id of the last fighter to damage this one).
  lastAttackerId = -1;

  // True while some system fully owns this fighter's position this tick
  // (charges/dashes/leaps/grabs) so MovementSystem skips normal locomotion.
  movementOwned = false;

  constructor(id: number, animal: AnimalId, def: AnimalDef, isPlayer: boolean, pos: Vec3, yaw: number) {
    this.id = id;
    this.def = def;
    this.state = makeState(id, animal, def, isPlayer, pos, yaw);
  }

  /** Copy intent fields in (no aliasing, no per-tick allocation). */
  setIntent(src: FighterIntent): void {
    const i = this.intent;
    i.moveX = src.moveX;
    i.moveZ = src.moveZ;
    i.aimYaw = src.aimYaw;
    i.attack = src.attack;
    i.block = src.block;
    i.special = src.special;
    i.ultimate = src.ultimate;
    i.jump = src.jump;
  }

  /** Compute rising edges for this tick from the stored intent. */
  computeEdges(): void {
    const i = this.intent;
    this.edgeAttack = i.attack && !this.prevAttack;
    this.edgeSpecial = i.special && !this.prevSpecial;
    this.edgeUlt = i.ultimate && !this.prevUlt;
    this.edgeJump = i.jump && !this.prevJump;
    this.prevAttack = i.attack;
    this.prevSpecial = i.special;
    this.prevUlt = i.ultimate;
    this.prevJump = i.jump;
  }

  /** True when hard CC / death forbids voluntarily starting a new action. */
  isDisabled(): boolean {
    return (
      !this.state.alive ||
      this.knockdownTimer > 0 ||
      this.staggerTimer > 0 ||
      this.fearTimer > 0 ||
      this.state.grabbedById !== -1
    );
  }

  resetCombo(): void {
    this.nextComboStep = 0;
    this.chainQueued = false;
    this.swinging = false;
    this.hasHitThisSwing = false;
    this.sinceSwingEnd = 999;
    this.state.comboIndex = 0;
    this.state.comboWindow = 0;
  }

  /** Cancel the current swing and (non-grab) ability; used by CC & specials/ults. */
  interrupt(): void {
    if (this.ccImmune) return;
    this.swinging = false;
    this.hasHitThisSwing = false;
    this.chainQueued = false;
    if (this.ability !== null && !this.ability.isGrab) {
      this.ability = null;
    }
    this.nextComboStep = 0;
    this.state.comboIndex = 0;
    this.state.comboWindow = 0;
  }

  setKnockback(dirX: number, dirZ: number, dist: number): void {
    // Cover `dist` metres over the impulse window (§7.8).
    const speed = dist / MOVE.knockbackImpulseDur;
    this.knockVX = dirX * speed;
    this.knockVZ = dirZ * speed;
    this.knockTimer = MOVE.knockbackImpulseDur;
  }

  /** Decrement simple per-tick timers (buffs handled separately). */
  tickTimers(dt: number): void {
    if (this.state.specialCd > 0) this.state.specialCd = Math.max(0, this.state.specialCd - dt);
    if (this.glideCd > 0) this.glideCd = Math.max(0, this.glideCd - dt);
    if (this.hitstunTimer > 0) this.hitstunTimer = Math.max(0, this.hitstunTimer - dt);
    if (this.rootTimer > 0) this.rootTimer = Math.max(0, this.rootTimer - dt);
    if (this.disarmTimer > 0) this.disarmTimer = Math.max(0, this.disarmTimer - dt);
    if (this.ambushBonusTimer > 0) this.ambushBonusTimer = Math.max(0, this.ambushBonusTimer - dt);
    if (this.state.guardRegenDelay > 0) this.state.guardRegenDelay = Math.max(0, this.state.guardRegenDelay - dt);
  }

  get x(): number {
    return this.state.pos.x;
  }
  get z(): number {
    return this.state.pos.z;
  }
}
