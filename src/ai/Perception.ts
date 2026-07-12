/**
 * Perception layer (BLUEPRINT §10.1).
 *
 * A bot may only know what a player could know: the {@link WorldSnapshot} and
 * the {@link GameEvent} stream — never sim internals. Every observation is
 * buffered by the profile's `reactionMs` before the brain may act on it:
 *  - snapshots: the brain reads a DELAYED snapshot (ring-buffered by the
 *    BotManager) for everything about OTHER fighters; its own state is read
 *    live (proprioception is instant for human players too).
 *  - events: queued here with a release timestamp of `now + reactionMs`.
 *
 * Line of sight is a 2D ray against the 6 stone pillars only (crates and low
 * walls do not block sight, §10); both fighters are always inside the wall so
 * the wall never occludes. Stealthed panthers are lost (last-known position is
 * frozen) until they attack. Untargetable fighters (burrowed mole, soaring
 * eagle) cannot be targeted but their last-known position is remembered.
 */

import type { AnimalId, FighterAction, FighterState, GameEvent, WorldSnapshot } from '../core/types';
import { PILLARS } from '../config/arena';

/** Flattened pillar circles for the LOS test (radius² precomputed). */
const LOS_PILLARS: readonly { x: number; z: number; rSq: number }[] = PILLARS.map((p) => ({
  x: p.x,
  z: p.z,
  rSq: p.radius * p.radius,
}));

/** True when the segment (ax,az)→(bx,bz) is not occluded by any pillar. */
export function hasLineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  for (let i = 0; i < LOS_PILLARS.length; i++) {
    const p = LOS_PILLARS[i];
    let t = 0;
    if (lenSq > 1e-9) {
      t = ((p.x - ax) * dx + (p.z - az) * dz) / lenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const cx = ax + dx * t - p.x;
    const cz = az + dz * t - p.z;
    if (cx * cx + cz * cz <= p.rSq) return false;
  }
  return true;
}

/** How long a lost contact's last-known position stays worth chasing (s). */
export const MEMORY_SECONDS = 4;

/** Everything the brain knows about one other fighter (delayed view + memory). */
export interface TrackedEnemy {
  id: number;
  animal: AnimalId;
  alive: boolean;
  /** Perceived right now (alive, LOS clear, not stealth-hidden). */
  visible: boolean;
  /** May be selected as a target (not burrowed / not soaring eagle). */
  targetable: boolean;
  /** Best-known position: live (delayed) if visible, else frozen last-known. */
  x: number;
  z: number;
  velX: number;
  velZ: number;
  yaw: number;
  hpFrac: number;
  guardFrac: number;
  action: FighterAction;
  actionT: number;
  actionDur: number;
  /** Previous tick's action — used to edge-detect incoming swings. */
  lastAction: FighterAction;
  /** Action transitioned into attack1/2/3 this tick. */
  swingStarted: boolean;
  blocking: boolean;
  /** Stagger / knockdown / grabbed — a punish window. */
  helpless: boolean;
  rooted: boolean;
  /** Horizontal distance from our own (live) position to best-known position. */
  dist: number;
  lastSeen: number;
  /** Stealth reveal window (set when the stealthed fighter attacks). */
  revealedUntil: number;
}

function isAttackAction(a: FighterAction): boolean {
  return a === 'attack1' || a === 'attack2' || a === 'attack3';
}

interface QueuedEvent {
  ev: GameEvent;
  at: number;
}

export class Perception {
  readonly selfId: number;
  /** Reaction latency (seconds); the manager keeps this in sync with profile. */
  reactionS: number;

  /** One tracked record per fighter id (self slot exists but is unused). */
  readonly enemies: TrackedEnemy[] = [];
  /** Events whose reaction delay elapsed this tick (reset every update). */
  readonly ready: GameEvent[] = [];

  private queue: QueuedEvent[] = [];
  private qHead = 0;

  constructor(selfId: number, reactionS: number) {
    this.selfId = selfId;
    this.reactionS = reactionS;
  }

  /** Buffer an event; the brain sees it once `now >= at` (reaction delay). */
  pushEvent(ev: GameEvent, at: number): void {
    this.queue.push({ ev, at });
  }

  /**
   * Refresh perceived state. `self` is the live own state, `delayed` is the
   * snapshot from ~reactionMs ago (others are perceived through it).
   */
  update(now: number, self: FighterState, delayed: WorldSnapshot): void {
    // Release matured events (queue is FIFO; release times are monotonic).
    this.ready.length = 0;
    while (this.qHead < this.queue.length && this.queue[this.qHead].at <= now) {
      this.ready.push(this.queue[this.qHead].ev);
      this.qHead++;
    }
    if (this.qHead > 128) {
      this.queue.splice(0, this.qHead);
      this.qHead = 0;
    }

    const fighters = delayed.fighters;
    // Lazily create tracked records (fixed indices; no per-tick allocation after).
    if (this.enemies.length !== fighters.length) {
      this.enemies.length = 0;
      for (let i = 0; i < fighters.length; i++) {
        const f = fighters[i];
        this.enemies.push({
          id: f.id,
          animal: f.animal,
          alive: f.alive,
          visible: false,
          targetable: false,
          x: f.pos.x,
          z: f.pos.z,
          velX: 0,
          velZ: 0,
          yaw: f.yaw,
          hpFrac: 1,
          guardFrac: 1,
          action: f.action,
          actionT: 0,
          actionDur: 0,
          lastAction: f.action,
          swingStarted: false,
          blocking: false,
          helpless: false,
          rooted: false,
          dist: 0,
          lastSeen: -1e9,
          revealedUntil: -1e9,
        });
      }
    }

    // Reveal stealthed attackers via released hit/blocked events.
    for (let i = 0; i < this.ready.length; i++) {
      const ev = this.ready[i];
      if (ev.type === 'hit' || ev.type === 'blocked') {
        const t = this.enemies[ev.attackerId];
        if (t !== undefined && ev.attackerId !== this.selfId) t.revealedUntil = now + 3;
      }
    }

    const sx = self.pos.x;
    const sz = self.pos.z;
    for (let i = 0; i < fighters.length; i++) {
      if (i === this.selfId) continue;
      const f = fighters[i];
      const t = this.enemies[i];
      t.alive = f.alive;
      t.swingStarted = false;
      if (!f.alive) {
        t.visible = false;
        t.targetable = false;
        continue;
      }

      // Untargetable phases: burrowed mole, soaring eagle (DFA ult).
      const untargetable = f.action === 'burrowed' || (f.animal === 'eagle' && f.action === 'ultimate');

      // Stealth: hidden unless recently revealed by an attack.
      let stealthed = false;
      for (let b = 0; b < f.buffs.length; b++) {
        if (f.buffs[b].kind === 'stealth') {
          stealthed = true;
          break;
        }
      }
      const hidden = (stealthed && now > t.revealedUntil) || untargetable;
      const seen = !hidden && hasLineOfSight(sx, sz, f.pos.x, f.pos.z);

      t.targetable = !untargetable && !hidden && f.alive;
      t.visible = seen;
      if (seen) {
        const prev = t.action;
        const prevT = t.actionT;
        t.x = f.pos.x;
        t.z = f.pos.z;
        t.velX = f.vel.x;
        t.velZ = f.vel.z;
        t.yaw = f.yaw;
        t.hpFrac = f.maxHp > 0 ? f.hp / f.maxHp : 0;
        t.guardFrac = f.maxGuard > 0 ? f.guard / f.maxGuard : 0;
        t.lastAction = prev;
        t.action = f.action;
        t.actionT = f.actionT;
        t.actionDur = f.actionDur;
        // New swing: entered an attack action, chained to the next combo step,
        // or restarted the same step (actionT jumped backwards).
        t.swingStarted =
          isAttackAction(f.action) &&
          (!isAttackAction(prev) || f.action !== prev || f.actionT < prevT - 1e-6);
        t.blocking = f.action === 'block';
        t.helpless =
          f.action === 'stagger' || f.action === 'knockdown' || f.action === 'grabbed' || f.action === 'feared';
        t.rooted = false;
        for (let b = 0; b < f.buffs.length; b++) {
          if (f.buffs[b].kind === 'root') {
            t.rooted = true;
            break;
          }
        }
        t.lastSeen = now;
      } else {
        // Frozen last-known contact; decays via lastSeen.
        t.velX = 0;
        t.velZ = 0;
        t.blocking = false;
        t.helpless = false;
        t.swingStarted = false;
      }
      const dx = t.x - sx;
      const dz = t.z - sz;
      t.dist = Math.sqrt(dx * dx + dz * dz);
    }
  }
}
