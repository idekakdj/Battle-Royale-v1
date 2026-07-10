/**
 * World — the headless simulation entry point (BLUEPRINT §5.1 API). Owns the
 * fixed-timestep tick pipeline, match flow (§6), hp/death/placement bookkeeping,
 * bloodlust ramp and snapshot production. Deterministic: all randomness comes
 * from a seeded mulberry32; zero Math.random; no three/DOM imports.
 *
 * COUNTDOWN EXPOSURE (integration note): {@link WorldSnapshot} has no dedicated
 * countdown field, so during the 3 s pre-fight freeze `snapshot().time` is
 * NEGATIVE and equals −(seconds remaining); it reaches 0 at FIGHT and counts up
 * thereafter. `time < 0` ⇒ countdown active, `|time|` = seconds until the fight.
 */

import type {
  FighterIntent,
  FighterState,
  GameEvent,
  MatchConfig,
  PickupState,
  WorldSnapshot,
  BuffState,
} from '../core/types';
import { EventBus } from '../core/EventBus';
import { mulberry32, dirToYaw, type Rng } from '../core/math';
import { ANIMALS } from '../config/animals';
import { MATCH, BLOODLUST, ULT } from '../config/balance';
import { PILLARS, FALLEN_COLUMNS, CRATES } from '../config/arena';
import type { Obstacle } from '../config/arena';
import { Fighter, type Sim, type CrateRuntime } from './Fighter';
import { groundHeightAt, locomote, resolveFighterCollisions } from './MovementSystem';
import { tickBuffs } from './StatusEffects';
import { updateGuard, setBlocking, tryStartSwing, updateSwing } from './CombatSystem';
import { startSpecial, startUlt, updateAbility } from './abilities1';
import { createPickups, updatePickups } from './PickupSystem';

const STATIC_OBSTACLES: readonly Obstacle[] = [...PILLARS, ...FALLEN_COLUMNS];

export class World implements Sim {
  readonly fighters: Fighter[] = [];
  readonly crates: CrateRuntime[];
  readonly staticObstacles: readonly Obstacle[] = STATIC_OBSTACLES;
  readonly bus: EventBus;
  readonly rng: Rng;

  time = 0; // fight clock (≥0); negative countdown is reported via snapshot.time
  bloodlustMult: number = BLOODLUST.base;

  private countdownRemaining: number = MATCH.countdown;
  private pickups: PickupState[];
  private deaths = 0;
  matchOver = false;
  private winnerId = -1;

  constructor(cfg: MatchConfig, seed: number, bus: EventBus) {
    this.bus = bus;
    this.rng = mulberry32(seed);

    const n = cfg.roster.length;
    const stepDeg = n > 0 ? 360 / n : MATCH.spawnStepDeg;
    for (let i = 0; i < n; i++) {
      const entry = cfg.roster[i];
      const def = ANIMALS[entry.animal];
      const angle = ((270 + stepDeg * i) * Math.PI) / 180;
      const x = MATCH.spawnRing * Math.cos(angle);
      const z = MATCH.spawnRing * Math.sin(angle);
      const yaw = dirToYaw(-x, -z); // face arena centre
      const pos = { x, y: groundHeightAt(x, z), z };
      this.fighters.push(new Fighter(i, entry.animal, def, entry.isPlayer, pos, yaw));
    }

    this.crates = CRATES.map((c, id) => ({
      id,
      x: c.x,
      z: c.z,
      halfX: c.halfX,
      halfZ: c.halfZ,
      height: c.height,
      hp: c.hp,
      alive: true,
    }));

    this.pickups = createPickups(this.rng);
  }

  // ── Public API (§5.1) ──────────────────────────────────────────────────────

  setIntent(id: number, intent: FighterIntent): void {
    const f = this.fighters[id];
    if (f !== undefined) f.setIntent(intent);
  }

  step(dt: number): void {
    if (this.matchOver) return;

    // Pre-fight countdown: sim frozen (§6).
    if (this.countdownRemaining > 0) {
      this.countdownRemaining = Math.max(0, this.countdownRemaining - dt);
      return;
    }

    this.time += dt;
    this.updateBloodlust();

    const fs = this.fighters;

    // 0. Reset per-tick ownership flags.
    for (let i = 0; i < fs.length; i++) fs[i].movementOwned = false;

    // 1. Edges, timers, buffs, CC decrement, guard.
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (!f.state.alive) continue;
      f.computeEdges();
      f.tickTimers(dt);
      tickBuffs(this, f, dt);
      if (f.rampageTimer > 0) {
        f.rampageTimer = Math.max(0, f.rampageTimer - dt);
        if (f.rampageTimer <= 0) f.rampageKnockback = 0;
      }
      f.ccImmune = f.ccImmuneChannel || f.rampageTimer > 0;
      if (f.staggerTimer > 0) f.staggerTimer = Math.max(0, f.staggerTimer - dt);
      if (f.knockdownTimer > 0) f.knockdownTimer = Math.max(0, f.knockdownTimer - dt);
      if (f.fearTimer > 0) f.fearTimer = Math.max(0, f.fearTimer - dt);
      updateGuard(f, dt);
    }

    // 2. Decisions & actions (block / attack / special / ultimate / abilities).
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (!f.state.alive) continue;

      if (f.ability !== null) {
        updateAbility(this, f, dt);
        continue;
      }
      if (f.isDisabled()) {
        f.blocking = false;
        f.swinging = false;
        continue;
      }
      if (f.hitstunTimer > 0) {
        f.blocking = false;
        updateSwing(this, f, dt);
        continue;
      }

      if (f.edgeUlt && f.state.ultCharge >= ULT.cost) {
        startUlt(this, f);
        continue;
      }
      if (f.edgeSpecial && f.state.specialCd <= 0) {
        startSpecial(this, f);
        continue;
      }

      const wantBlock = f.intent.block && !f.swinging && !f.state.airborne;
      setBlocking(this, f, wantBlock);
      if (!f.blocking && f.edgeAttack) tryStartSwing(f);
      updateSwing(this, f, dt);
    }

    // 3. Movement + collision.
    for (let i = 0; i < fs.length; i++) {
      if (fs[i].state.alive) locomote(this, fs[i], dt);
    }
    resolveFighterCollisions(this);

    // 4. Pickups.
    updatePickups(this, this.pickups, dt);

    // 5. Deaths & match end.
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (f.state.alive && f.state.hp <= 0) this.kill(f);
    }
    this.checkMatchEnd();

    // 6. Resolve visible action for the renderer/AI.
    for (let i = 0; i < fs.length; i++) this.resolveAction(fs[i]);
  }

  snapshot(): WorldSnapshot {
    const fighters: FighterState[] = new Array(this.fighters.length);
    for (let i = 0; i < this.fighters.length; i++) fighters[i] = cloneState(this.fighters[i].state);
    const pickups: PickupState[] = this.pickups.map((p) => ({
      id: p.id,
      kind: p.kind,
      pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      active: p.active,
      respawnT: p.respawnT,
    }));
    const crates = this.crates.map((c) => ({ id: c.id, pos: { x: c.x, y: 0, z: c.z }, hp: c.hp, alive: c.alive }));
    return {
      time: this.countdownRemaining > 0 ? -this.countdownRemaining : this.time,
      fighters,
      pickups,
      crates,
      bloodlustMult: this.bloodlustMult,
      matchOver: this.matchOver,
      winnerId: this.winnerId,
    };
  }

  /** Seconds remaining in the pre-fight countdown (0 once FIGHT begins). */
  get countdown(): number {
    return this.countdownRemaining;
  }

  // ── Sim implementation ─────────────────────────────────────────────────────

  emit(ev: GameEvent): void {
    this.bus.emit(ev);
  }

  dealHp(attacker: Fighter | null, target: Fighter, amount: number): void {
    if (amount <= 0 || !target.state.alive) return;
    const applied = Math.min(amount, target.state.hp);
    if (applied <= 0) return;
    target.state.hp -= applied;
    if (attacker !== null && attacker !== target) {
      target.lastAttackerId = attacker.id;
      attacker.state.damageDealt += applied;
    }
  }

  applyBleedDamage(source: Fighter, target: Fighter, amount: number): void {
    this.dealHp(source, target, amount);
  }

  damageCrate(crate: CrateRuntime, amount: number): void {
    if (!crate.alive) return;
    crate.hp -= amount;
    if (crate.hp <= 0) {
      crate.hp = 0;
      crate.alive = false;
      this.emit({ type: 'crateBreak', crateId: crate.id, pos: { x: crate.x, y: 0, z: crate.z } });
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private updateBloodlust(): void {
    if (this.time < BLOODLUST.startTime) {
      this.bloodlustMult = BLOODLUST.base;
      return;
    }
    const steps = 1 + Math.floor((this.time - BLOODLUST.startTime) / BLOODLUST.stepInterval);
    this.bloodlustMult = Math.min(BLOODLUST.cap, BLOODLUST.base + BLOODLUST.step * steps);
  }

  private kill(f: Fighter): void {
    f.state.alive = false;
    f.state.hp = 0;
    f.state.action = 'dead';
    f.blocking = false;
    f.swinging = false;

    // Release any grab this fighter was involved in.
    if (f.state.grabTargetId >= 0) {
      const held = this.fighters[f.state.grabTargetId];
      if (held !== undefined) held.state.grabbedById = -1;
      f.state.grabTargetId = -1;
    }
    if (f.state.grabbedById >= 0) {
      const grabber = this.fighters[f.state.grabbedById];
      if (grabber !== undefined && grabber.ability !== null) grabber.ability.targetId = -1;
      f.state.grabbedById = -1;
    }
    f.ability = null;

    const placement = 10 - this.deaths; // 1st death → 10th place (§6)
    this.deaths += 1;
    const killerId = f.lastAttackerId;
    if (killerId >= 0 && killerId !== f.id) {
      const killer = this.fighters[killerId];
      if (killer !== undefined) killer.state.kills += 1;
    }
    this.emit({ type: 'death', targetId: f.id, killerId, placement });
  }

  private checkMatchEnd(): void {
    if (this.matchOver) return;
    let aliveCount = 0;
    let lastAlive = -1;
    for (let i = 0; i < this.fighters.length; i++) {
      if (this.fighters[i].state.alive) {
        aliveCount += 1;
        lastAlive = this.fighters[i].id;
      }
    }
    if (aliveCount <= 1) {
      this.matchOver = true;
      this.winnerId = lastAlive;
      this.emit({ type: 'matchEnd', winnerId: lastAlive });
    }
  }

  private resolveAction(f: Fighter): void {
    const s = f.state;
    if (!s.alive) {
      s.action = 'dead';
      return;
    }
    if (f.ability !== null) return; // special/ultimate/grab/burrowed set by the ability
    if (s.grabbedById !== -1) {
      s.action = 'grabbed';
      return;
    }
    if (f.knockdownTimer > 0) {
      s.action = 'knockdown';
      return;
    }
    if (f.staggerTimer > 0) {
      s.action = 'stagger';
      return;
    }
    if (f.fearTimer > 0) {
      s.action = 'feared';
      return;
    }
    if (f.swinging) return; // attack1/2/3 already set by updateSwing
    if (f.hitstunTimer > 0) {
      s.action = 'hit';
      return;
    }
    if (f.blocking) {
      s.action = 'block';
      return;
    }
    if (s.airborne) {
      s.action = s.glideT > 0 ? 'glide' : 'jump';
      return;
    }
    const speed = Math.sqrt(s.vel.x * s.vel.x + s.vel.z * s.vel.z);
    s.action = speed > 0.3 ? 'run' : 'idle';
  }
}

function cloneState(s: FighterState): FighterState {
  const buffs: BuffState[] = new Array(s.buffs.length);
  for (let i = 0; i < s.buffs.length; i++) {
    const b = s.buffs[i];
    buffs[i] = { kind: b.kind, t: b.t, dur: b.dur, mag: b.mag };
  }
  return {
    id: s.id,
    animal: s.animal,
    isPlayer: s.isPlayer,
    alive: s.alive,
    pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
    vel: { x: s.vel.x, y: s.vel.y, z: s.vel.z },
    yaw: s.yaw,
    hp: s.hp,
    maxHp: s.maxHp,
    guard: s.guard,
    maxGuard: s.maxGuard,
    guardRegenDelay: s.guardRegenDelay,
    ultCharge: s.ultCharge,
    specialCd: s.specialCd,
    action: s.action,
    actionT: s.actionT,
    actionDur: s.actionDur,
    comboIndex: s.comboIndex,
    comboWindow: s.comboWindow,
    buffs,
    kills: s.kills,
    damageDealt: s.damageDealt,
    damageBlocked: s.damageBlocked,
    ultsUsed: s.ultsUsed,
    grabTargetId: s.grabTargetId,
    grabbedById: s.grabbedById,
    airborne: s.airborne,
    glideT: s.glideT,
    burrowT: s.burrowT,
  };
}

/** Barrel re-export so callers can `import { World } from './sim'`. */
export type { Sim } from './Fighter';
