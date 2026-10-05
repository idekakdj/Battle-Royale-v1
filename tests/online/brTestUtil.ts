/**
 * Shared helpers for the WP-N3 Battle Royale netcode tests: a recorder that plays a REAL headless match (World + BotManager,
 * 10 fighters) and captures every tick's snapshot + events, comparison helpers with the codec's documented tolerances,
 * and tiny builders.
 */

import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { ANIMAL_IDS } from '../../src/config/animals';
import type {
  AnimalId,
  Difficulty,
  FighterIntent,
  FighterState,
  GameEvent,
  GameEventOf,
  MatchConfig,
  WorldSnapshot,
} from '../../src/core/types';
import { TOLERANCE, angleDiff } from '../../src/online/br/tables';

export const DT = 1 / 60;

export interface Recording {
  /** snapshots[t] = state after tick t (60 Hz). */
  snapshots: WorldSnapshot[];
  /** events[t] = events emitted during tick t. */
  events: GameEvent[][];
  roster: MatchConfig['roster'];
}

export function tenAnimalConfig(difficulty: Difficulty): MatchConfig {
  return { roster: (ANIMAL_IDS as AnimalId[]).map((a) => ({ animal: a, isPlayer: false })), difficulty };
}

/** Plays `fightSeconds` of fight time (after the 3 s countdown) with bot brains; records every tick. */
export function recordMatch(seed: number, difficulty: Difficulty, fightSeconds: number): Recording {
  const cfg = tenAnimalConfig(difficulty);
  const bus = new EventBus();
  let current: GameEvent[] = [];
  bus.onAny((e) => current.push(e));
  const world = new World(cfg, seed, bus);
  const bots = new BotManager(bus, difficulty, seed);
  const snapshots: WorldSnapshot[] = [];
  const events: GameEvent[][] = [];
  const ticks = Math.ceil((3 + fightSeconds) * 60) + 2;
  for (let t = 0; t < ticks; t++) {
    const before = world.snapshot();
    bots.update(before, DT);
    for (let id = 0; id < cfg.roster.length; id++) world.setIntent(id, bots.getIntent(id));
    current = [];
    world.step(DT);
    snapshots.push(world.snapshot());
    events.push(current);
    if (world.matchOver) break;
  }
  return { snapshots, events, roster: cfg.roster };
}

let cached: Recording | null = null;
/** 60 s apex-level free-for-all (cached per test file). */
export function busyMatch(): Recording {
  cached ??= recordMatch(4242, 4, 60);
  return cached;
}

// ── Comparison with the codec's tolerances ───────────────────────────────────

const fmt = (v: unknown): string => JSON.stringify(v);

export function fighterMismatches(o: FighterState, d: FighterState): string[] {
  const bad: string[] = [];
  const eq = (name: string, a: unknown, b: unknown): void => {
    if (a !== b) bad.push(`${name}: ${fmt(a)} vs ${fmt(b)}`);
  };
  const near = (name: string, a: number, b: number, tol: number): void => {
    if (!(Math.abs(a - b) <= tol)) bad.push(`${name}: ${a} vs ${b} (tol ${tol})`);
  };
  eq('id', o.id, d.id);
  eq('animal', o.animal, d.animal);
  eq('isPlayer', o.isPlayer, d.isPlayer);
  eq('alive', o.alive, d.alive);
  near('pos.x', o.pos.x, d.pos.x, TOLERANCE.pos);
  near('pos.y', o.pos.y, d.pos.y, TOLERANCE.pos);
  near('pos.z', o.pos.z, d.pos.z, TOLERANCE.pos);
  near('vel.x', o.vel.x, d.vel.x, TOLERANCE.vel);
  near('vel.y', o.vel.y, d.vel.y, TOLERANCE.vel);
  near('vel.z', o.vel.z, d.vel.z, TOLERANCE.vel);
  near('yaw', 0, angleDiff(o.yaw, d.yaw), TOLERANCE.angle);
  near('hp', o.hp, d.hp, TOLERANCE.hp);
  if (o.hp > 1e-6 && d.hp <= 0) bad.push('hp>0 decoded as 0');
  near('maxHp', o.maxHp, d.maxHp, 1e-3);
  near('guard', o.guard, d.guard, TOLERANCE.hp);
  near('maxGuard', o.maxGuard, d.maxGuard, 1e-3);
  near('guardRegenDelay', o.guardRegenDelay, d.guardRegenDelay, TOLERANCE.time);
  near('ultCharge', o.ultCharge, d.ultCharge, TOLERANCE.ult);
  if (o.ultCharge >= 100 !== d.ultCharge >= 100) bad.push(`ult ready flag differs: ${o.ultCharge} vs ${d.ultCharge}`);
  near('specialCd', o.specialCd, d.specialCd, 0.01 + 1e-9);
  if (o.specialCd > 1e-6 && d.specialCd <= 0) bad.push('running cooldown decoded as ready');
  eq('action', o.action, d.action);
  near('actionT', o.actionT, d.actionT, TOLERANCE.time);
  near('actionDur', o.actionDur, d.actionDur, TOLERANCE.time);
  eq('comboIndex', o.comboIndex, d.comboIndex);
  near('comboWindow', o.comboWindow, d.comboWindow, TOLERANCE.time);
  eq('buffs.length', o.buffs.length, d.buffs.length);
  for (let i = 0; i < Math.min(o.buffs.length, d.buffs.length); i++) {
    eq(`buff${i}.kind`, o.buffs[i].kind, d.buffs[i].kind);
    near(`buff${i}.t`, o.buffs[i].t, d.buffs[i].t, TOLERANCE.time);
    near(`buff${i}.dur`, o.buffs[i].dur, d.buffs[i].dur, TOLERANCE.time);
    near(`buff${i}.mag`, o.buffs[i].mag, d.buffs[i].mag, Math.abs(o.buffs[i].mag) * 1e-6 + 1e-9);
  }
  eq('kills', o.kills, d.kills);
  near('damageDealt', o.damageDealt, d.damageDealt, 1 / 32 + 1e-9);
  near('damageBlocked', o.damageBlocked, d.damageBlocked, 1 / 32 + 1e-9);
  eq('ultsUsed', o.ultsUsed, d.ultsUsed);
  eq('grabTargetId', o.grabTargetId, d.grabTargetId);
  eq('grabbedById', o.grabbedById, d.grabbedById);
  eq('airborne', o.airborne, d.airborne);
  near('glideT', o.glideT, d.glideT, TOLERANCE.time);
  near('burrowT', o.burrowT, d.burrowT, TOLERANCE.time);
  eq('ultPhase', o.ultPhase, d.ultPhase);
  eq('ultStage', o.ultStage, d.ultStage);
  eq('ultTargetId', o.ultTargetId, d.ultTargetId);
  return bad;
}

/** Every difference between a snapshot and its decoded round trip (empty = within tolerance). */
export function snapshotMismatches(o: WorldSnapshot, d: WorldSnapshot): string[] {
  const bad: string[] = [];
  const near = (name: string, a: number, b: number, tol: number): void => {
    if (!(Math.abs(a - b) <= tol)) bad.push(`${name}: ${a} vs ${b} (tol ${tol})`);
  };
  near('time', o.time, d.time, 0.0005 + 1e-9);
  near('bloodlustMult', o.bloodlustMult, d.bloodlustMult, 0.0005 + 1e-9);
  if (o.matchOver !== d.matchOver) bad.push('matchOver');
  if (o.matchOver && o.winnerId !== d.winnerId) bad.push(`winnerId ${o.winnerId} vs ${d.winnerId}`);
  if (o.fighters.length !== d.fighters.length) return [...bad, 'fighter count'];
  for (let i = 0; i < o.fighters.length; i++) for (const m of fighterMismatches(o.fighters[i], d.fighters[i])) bad.push(`fighter${i}.${m}`);
  if (o.pickups.length !== d.pickups.length) bad.push('pickup count');
  else {
    for (let i = 0; i < o.pickups.length; i++) {
      const p = o.pickups[i];
      const q = d.pickups[i];
      if (p.id !== q.id || p.kind !== q.kind || p.active !== q.active) bad.push(`pickup${i}`);
      near(`pickup${i}.respawnT`, p.respawnT, q.respawnT, TOLERANCE.time);
      near(`pickup${i}.x`, p.pos.x, q.pos.x, TOLERANCE.pos);
      near(`pickup${i}.z`, p.pos.z, q.pos.z, TOLERANCE.pos);
    }
  }
  if (o.crates.length !== d.crates.length) bad.push('crate count');
  else {
    for (let i = 0; i < o.crates.length; i++) {
      const c = o.crates[i];
      const e = d.crates[i];
      if (c.id !== e.id || c.alive !== e.alive) bad.push(`crate${i}`);
      near(`crate${i}.hp`, c.hp, e.hp, 0.125 + 1e-9);
      near(`crate${i}.x`, c.pos.x, e.pos.x, TOLERANCE.pos);
    }
  }
  if (o.traps.length !== d.traps.length) bad.push('trap count');
  else {
    for (let i = 0; i < o.traps.length; i++) {
      const t = o.traps[i];
      const u = d.traps[i];
      if (t.id !== u.id || t.kind !== u.kind || t.phase !== u.phase || t.triggeredBy !== u.triggeredBy) bad.push(`trap${i}`);
      near(`trap${i}.timeLeft`, t.timeLeft, u.timeLeft, TOLERANCE.time);
      near(`trap${i}.radius`, t.radius, u.radius, 1e-6);
      near(`trap${i}.x`, t.pos.x, u.pos.x, TOLERANCE.pos);
    }
  }
  const po = o.projectiles;
  const pd = d.projectiles;
  if ((po === undefined) !== (pd === undefined)) bad.push('projectiles presence');
  else if (po !== undefined && pd !== undefined) {
    if (po.length !== pd.length) bad.push('projectile count');
    else {
      for (let i = 0; i < po.length; i++) {
        if (po[i].id !== pd[i].id || po[i].ownerId !== pd[i].ownerId || po[i].kind !== pd[i].kind) bad.push(`projectile${i}`);
        near(`projectile${i}.x`, po[i].pos.x, pd[i].pos.x, TOLERANCE.pos);
        near(`projectile${i}.vx`, po[i].vel.x, pd[i].vel.x, TOLERANCE.vel);
        near(`projectile${i}.radius`, po[i].radius, pd[i].radius, 0.0005 + 1e-9);
      }
    }
  }
  return bad;
}

export function neutral(): FighterIntent {
  return { moveX: 0, moveZ: 0, aimYaw: 0, attack: false, block: false, special: false, ultimate: false, jump: false };
}

/** Deterministic PRNG for tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const P = { x: 1.234, y: 0.5, z: -7.891 };
const Q = { x: -20.5, y: 3.25, z: 14.75 };

/**
 * One representative instance of EVERY GameEvent variant. Typed as a mapped type over the union: adding a variant to
 * `GameEvent` fails to compile until a sample is added here (and an entry in EVENT_CODECS / EVENT_ID_FIELDS).
 */
export const SAMPLES: { [K in GameEvent['type']]: GameEventOf<K> } = {
  hit: { type: 'hit', attackerId: 3, targetId: 7, damage: 87.25, pos: P, heavy: true },
  blocked: { type: 'blocked', attackerId: 2, targetId: 9, damage: 41.5, pos: Q },
  guardBreak: { type: 'guardBreak', targetId: 4, pos: P },
  death: { type: 'death', targetId: 5, killerId: -1, placement: 7 },
  ultimate: { type: 'ultimate', fighterId: 6, animal: 'rhino' },
  special: { type: 'special', fighterId: 1, animal: 'python' },
  telegraph: { type: 'telegraph', fighterId: 8, kind: 'ultimate', pos: P, radius: 4.5, yaw: -1.2, arcDeg: 120, windup: 0.85 },
  pickup: { type: 'pickup', fighterId: 0, kind: 'rage', pos: Q },
  comboFinisher: { type: 'comboFinisher', fighterId: 3 },
  crateBreak: { type: 'crateBreak', crateId: 11, pos: P },
  swingImpact: { type: 'swingImpact', fighterId: 2, pos: Q, yaw: 3.0, range: 2.6, arcDeg: 360, step: 2 },
  ultimateTarget: { type: 'ultimateTarget', fighterId: 5, animal: 'gorilla', kind: 'ground', targetId: -1, from: P, to: Q, range: 14, width: 5.5, windup: 0.6 },
  ultimateFizzle: { type: 'ultimateFizzle', fighterId: 9, reason: 'noTarget' },
  ultimateStage: { type: 'ultimateStage', fighterId: 4, animal: 'lion', stage: 3, targetId: 8, pos: P },
  blink: { type: 'blink', fighterId: 6, from: P, to: Q },
  projectileImpact: { type: 'projectileImpact', kind: 'boulder', pos: Q, radius: 3.2, ownerId: 5, hitId: 2 },
  trapTriggered: { type: 'trapTriggered', trapId: 3, kind: 'spikes', pos: P, fighterId: 1 },
  trapDamage: { type: 'trapDamage', trapId: 2, kind: 'fire', targetId: 7, damage: 7, pos: Q },
  trapExpired: { type: 'trapExpired', trapId: 1, kind: 'fire', pos: P },
  landingImpact: { type: 'landingImpact', fighterId: 5, pos: Q, radius: 6, damage: 140.5, height: 11.75 },
  matchEnd: { type: 'matchEnd', winnerId: 4 },
};

