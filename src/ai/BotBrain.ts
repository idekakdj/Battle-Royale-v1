/**
 * BotBrain — one bot's decision (utility scores @ 10 Hz, §10.2) and executor
 * (steering + combat micro, §10.3). Reads only the perceived view (delayed
 * snapshot + reaction-buffered events via {@link Perception}) plus its own live
 * state, and writes a single reused {@link FighterIntent}.
 */

import type { FighterIntent, FighterState, WorldSnapshot } from '../core/types';
import { ANIMALS, type AnimalDef } from '../config/animals';
import { AI_TUNING, type BotProfile } from '../config/botProfiles';
import { PILLARS, WALL_RADIUS } from '../config/arena';
import { mulberry32, dirToYaw, angleDelta, DEG2RAD, type Rng } from '../core/math';
import { Perception, MEMORY_SECONDS, type TrackedEnemy } from './Perception';
import { BlockControl, sampleAimNoise, timeToImpact } from './CombatMicro';
import { decideAbilities, type Situation, type AbilityWish } from './scripts';
import { seek, flee, orbit, avoidObstacles, separation, type Move2 } from './Steering';

type Goal = 'engage' | 'retreat' | 'pickup' | 'defend' | 'special' | 'ultimate';

const DECISION_DT = 1 / AI_TUNING.decisionHz;

function isAttackAction(a: FighterState['action']): boolean {
  return a === 'attack1' || a === 'attack2' || a === 'attack3';
}

export class BotBrain {
  readonly id: number;
  readonly intent: FighterIntent = {
    moveX: 0,
    moveZ: 0,
    aimYaw: 0,
    attack: false,
    block: false,
    special: false,
    ultimate: false,
    jump: false,
  };
  readonly perception: Perception;
  profile: BotProfile;

  private readonly def: AnimalDef;
  private readonly rng: Rng;
  private readonly block = new BlockControl();
  private readonly move: Move2 = { x: 0, z: 0 };
  private readonly wish: AbilityWish = { special: false, ult: false, aimYaw: 0 };
  private readonly sit: Situation;

  private goal: Goal = 'engage';
  private targetId = -1;
  private decisionAcc: number;

  // Sampled at decision rate so the rng isn't drained every tick.
  private aimNoise = 0;
  private orbitSign: 1 | -1 = 1;
  private orbitFlipAt = 0;

  // Timed behavior windows (absolute manager time, seconds).
  private lastAttackPress = -1;
  private lastSpecialPress = -1;
  private punishUntil = -1; // whiff-punish aggression window
  private feintHoldUntil = -1; // hold follow-up after our hit got blocked
  private targetCommittedUntil = -1; // target cast a special (python punish)
  private recentFinisherUntil = -1; // own finisher landed (Veteran ult)
  private disengageUntil = -1; // hit-and-run exit (eagle etc.)
  private jumpHoldUntil = -1; // clearing a low wall / eagle glide
  private nextBaitPokeAt = 0; // rate-limits pokes into a raised block
  private pickupIdx = -1;
  private retreatHealIdx = -1;

  constructor(id: number, animal: FighterState['animal'], profile: BotProfile, seed: number) {
    this.id = id;
    this.def = ANIMALS[animal];
    this.profile = profile;
    this.rng = mulberry32(seed);
    this.perception = new Perception(id, profile.reactionMs / 1000);
    // Stagger decision ticks across bots (deterministically).
    this.decisionAcc = (id % 6) * 0.017;
    this.sit = {
      animal,
      profile,
      rng: this.rng,
      now: 0,
      hpFrac: 1,
      guardFrac: 1,
      specialReady: false,
      ultReady: false,
      retreating: false,
      hasTarget: false,
      tdist: 0,
      tHpFrac: 1,
      tGuardFrac: 1,
      targetHelpless: false,
      targetRooted: false,
      targetBlocking: false,
      targetCommitted: false,
      targetFleeing: false,
      targetIsolated: false,
      nearestEnemyDist: 1e9,
      enemiesNearSelf5: 0,
      enemiesNearSelf8: 0,
      enemiesNearTarget8: 0,
      wallBehindTarget: false,
      recentFinisher: false,
      aimYawToTarget: 0,
      aimYawAway: 0,
      aimYawNearest: 0,
    };
  }

  update(now: number, dt: number, current: WorldSnapshot, delayed: WorldSnapshot): void {
    const self = current.fighters[this.id];
    const intent = this.intent;

    // Edges are one-tick; clear them first.
    intent.attack = false;
    intent.special = false;
    intent.ultimate = false;

    if (self === undefined || !self.alive || current.matchOver) {
      intent.moveX = 0;
      intent.moveZ = 0;
      intent.block = false;
      intent.jump = false;
      return;
    }

    this.perception.update(now, self, delayed);
    this.processEvents(now, self);

    // Countdown: sim frozen — pick targets, do nothing else (§6, WP-C notes).
    if (current.time < 0) {
      this.selectTarget(now, self);
      intent.moveX = 0;
      intent.moveZ = 0;
      intent.block = false;
      intent.jump = false;
      const t = this.tracked(this.targetId);
      if (t !== null) intent.aimYaw = dirToYaw(t.x - self.pos.x, t.z - self.pos.z);
      return;
    }

    // Sim-enforced states we must not fight (§7.7 / grabs).
    const a = self.action;
    if (a === 'grabbed' || a === 'stagger' || a === 'knockdown' || a === 'feared' || a === 'grab') {
      intent.moveX = 0;
      intent.moveZ = 0;
      intent.block = false;
      intent.jump = false;
      return;
    }

    // Mid-ability channels: steer/emerge only.
    if (a === 'special' || a === 'ultimate' || a === 'burrowed') {
      this.driveChannel(now, self, a);
      return;
    }

    // 10 Hz utility decisions.
    this.decisionAcc -= dt;
    if (this.decisionAcc <= 0) {
      this.decisionAcc += DECISION_DT;
      this.decide(now, self, delayed);
    }

    this.execute(now, self, current);
  }

  // ── Perceived events (already reaction-delayed by Perception) ──────────────

  private processEvents(now: number, self: FighterState): void {
    const events = this.perception.ready;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      switch (ev.type) {
        case 'telegraph': {
          if (ev.fighterId === this.id) break;
          const dx = ev.pos.x - self.pos.x;
          const dz = ev.pos.z - self.pos.z;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d <= ev.radius + 2.5 && this.rng() < this.profile.blockOnTelegraphChance) {
            const caster = this.tracked(ev.fighterId);
            const yaw = caster !== null ? dirToYaw(caster.x - self.pos.x, caster.z - self.pos.z) : ev.yaw + Math.PI;
            this.block.schedule(now, ev.windup, yaw, this.profile.perfectBlockTry);
          }
          break;
        }
        case 'special': {
          if (ev.fighterId === this.targetId) this.targetCommittedUntil = now + 0.9;
          break;
        }
        case 'blocked': {
          // Our swing got blocked → hold the follow-up, punish the drop (§10 feints).
          if (ev.attackerId === this.id && this.profile.feints) this.feintHoldUntil = now + 0.55;
          // We blocked a hit → gorilla releases for the parry-shove read.
          if (ev.targetId === this.id && this.def.id === 'gorilla' && this.profile.specialUse === 'fullScripts') {
            this.block.releaseSoon(now);
          }
          break;
        }
        case 'comboFinisher': {
          if (ev.fighterId === this.id) this.recentFinisherUntil = now + 2;
          break;
        }
        case 'guardBreak': {
          if (ev.targetId === this.id) this.block.clear();
          break;
        }
        case 'death': {
          if (ev.targetId === this.targetId) this.targetId = -1;
          break;
        }
        default:
          break;
      }
    }
  }

  // ── Decision (10 Hz utility, §10.2) ─────────────────────────────────────────

  private tracked(id: number): TrackedEnemy | null {
    if (id < 0) return null;
    const t = this.perception.enemies[id];
    return t !== undefined && t.alive ? t : null;
  }

  /** Candidate usable as a target: alive, targetable, seen recently enough. */
  private isCandidate(t: TrackedEnemy, now: number): boolean {
    return t.alive && t.id !== this.id && t.targetable && now - t.lastSeen <= MEMORY_SECONDS;
  }

  private targetScore(t: TrackedEnemy): number {
    const p = this.profile;
    const closeness = 1 / (1 + t.dist * 0.15);
    switch (p.targetPolicy) {
      case 'nearest':
        return closeness;
      case 'lowestHpInRangeElseNearest':
        if (t.dist <= p.targetScanRangeM) return 1.5 + (1 - t.hpFrac) + closeness * 0.1;
        return closeness * 0.5;
      case 'weighted': {
        let others = 0;
        const es = this.perception.enemies;
        for (let i = 0; i < es.length; i++) {
          const o = es[i];
          if (o.id === t.id || o.id === this.id || !o.alive) continue;
          const dx = o.x - t.x;
          const dz = o.z - t.z;
          if (dx * dx + dz * dz <= 36) others++;
        }
        return (
          1.4 * (1 - t.hpFrac) +
          (others === 0 ? 0.9 : -0.5 * others) + // isolated bonus / cluster penalty
          (t.helpless ? 0.8 : 0) +
          closeness
        );
      }
    }
  }

  private selectTarget(now: number, self: FighterState): void {
    const es = this.perception.enemies;
    const cur = this.tracked(this.targetId);
    const curValid = cur !== null && this.isCandidate(cur, now);
    const curScore = curValid ? this.targetScore(cur) : -1;

    let best: TrackedEnemy | null = null;
    let bestScore = -1;
    for (let i = 0; i < es.length; i++) {
      const t = es[i];
      if (i === self.id || !this.isCandidate(t, now)) continue;
      const s = this.targetScore(t);
      if (s > bestScore) {
        bestScore = s;
        best = t;
      }
    }
    if (best === null) {
      if (!curValid) this.targetId = -1;
      return;
    }
    // Hysteresis: switch only for a ≥25% better score (§10.2).
    if (!curValid || best.id === this.targetId || bestScore >= curScore * (1 + AI_TUNING.targetSwitchMargin)) {
      this.targetId = best.id;
    }
  }

  private decide(now: number, self: FighterState, delayed: WorldSnapshot): void {
    const sit = this.sit;
    sit.now = now;
    this.selectTarget(now, self);

    const p = this.profile;
    const t = this.tracked(this.targetId);
    const sx = self.pos.x;
    const sz = self.pos.z;

    // Resample aim noise & orbit direction at decision rate.
    let blind = false;
    for (let i = 0; i < self.buffs.length; i++) {
      if (self.buffs[i].kind === 'blind') {
        blind = true;
        break;
      }
    }
    this.aimNoise = sampleAimNoise(this.rng, p.aimErrorDeg, blind);
    if (now >= this.orbitFlipAt) {
      this.orbitSign = this.rng() < 0.5 ? 1 : -1;
      this.orbitFlipAt = now + 2 + this.rng() * 3;
    }

    // Local density.
    let near5 = 0;
    let near8 = 0;
    let nearestDist = 1e9;
    let nearestId = -1;
    const es = this.perception.enemies;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (i === self.id || !e.alive || !e.visible) continue;
      if (e.dist <= 5) near5++;
      if (e.dist <= 8) near8++;
      if (e.dist < nearestDist) {
        nearestDist = e.dist;
        nearestId = i;
      }
    }

    // Fill the Situation for the ability scripts.
    sit.hpFrac = self.maxHp > 0 ? self.hp / self.maxHp : 0;
    sit.guardFrac = self.maxGuard > 0 ? self.guard / self.maxGuard : 0;
    sit.specialReady = self.specialCd <= 0;
    sit.ultReady = self.ultCharge >= 100;
    sit.retreating = this.goal === 'retreat';
    sit.hasTarget = t !== null;
    sit.enemiesNearSelf5 = near5;
    sit.enemiesNearSelf8 = near8;
    sit.nearestEnemyDist = nearestDist;
    sit.recentFinisher = now < this.recentFinisherUntil;
    const nearest = this.tracked(nearestId);
    sit.aimYawNearest =
      nearest !== null ? dirToYaw(nearest.x - sx, nearest.z - sz) + this.aimNoise : self.yaw;

    if (t !== null) {
      sit.tdist = t.dist;
      sit.tHpFrac = t.hpFrac;
      sit.tGuardFrac = t.guardFrac;
      sit.targetHelpless = t.helpless;
      sit.targetRooted = t.rooted;
      sit.targetBlocking = t.blocking;
      sit.targetCommitted =
        now < this.targetCommittedUntil || t.action === 'special' || t.action === 'ultimate';
      const toTx = t.x - sx;
      const toTz = t.z - sz;
      const td = t.dist > 1e-6 ? t.dist : 1;
      sit.targetFleeing = (t.velX * toTx + t.velZ * toTz) / td > 3;
      let othersNearTarget = 0;
      for (let i = 0; i < es.length; i++) {
        const o = es[i];
        if (i === self.id || i === t.id || !o.alive) continue;
        const dx = o.x - t.x;
        const dz = o.z - t.z;
        if (dx * dx + dz * dz <= 64) othersNearTarget++;
      }
      sit.enemiesNearTarget8 = othersNearTarget;
      sit.targetIsolated = othersNearTarget === 0;
      sit.aimYawToTarget = dirToYaw(toTx, toTz) + this.aimNoise;
      sit.aimYawAway = dirToYaw(-toTx, -toTz) + this.aimNoise;
      sit.wallBehindTarget =
        this.def.id === 'rhino' && p.specialUse === 'fullScripts'
          ? wallBehindTarget(sx, sz, t.x, t.z)
          : false;
    } else {
      sit.tdist = 1e9;
      sit.targetHelpless = false;
      sit.targetRooted = false;
      sit.targetBlocking = false;
      sit.targetCommitted = false;
      sit.targetFleeing = false;
      sit.targetIsolated = false;
      sit.enemiesNearTarget8 = 0;
      sit.aimYawToTarget = self.yaw;
      sit.aimYawAway = self.yaw + Math.PI;
      sit.wallBehindTarget = false;
    }

    decideAbilities(sit, this.wish);

    // ── Utility scores ────────────────────────────────────────────────────────
    const hpFrac = sit.hpFrac;
    const retreat = p.retreat;

    let engage = 0.25; // wander/pursue memory when no live target
    if (t !== null) {
      engage =
        0.6 +
        0.25 * (1 - t.hpFrac) +
        (t.helpless ? 0.15 : 0) -
        (retreat.avoidMultiTarget && sit.enemiesNearTarget8 >= 2 && t.hpFrac > 0.3 ? 0.35 : 0) -
        (retreat.mode !== 'never' && hpFrac <= retreat.hpThreshold ? 0.3 : 0);
    }

    let retreatScore = 0;
    const healIdx = this.findPickup(delayed, 'heal');
    this.retreatHealIdx = healIdx;
    if (retreat.mode !== 'never' && hpFrac <= retreat.hpThreshold) {
      retreatScore = 0.75 + (retreat.hpThreshold - hpFrac);
      if (retreat.mode === 'healSeek' && healIdx < 0) retreatScore = 0; // nothing to run to
    }

    let pickupScore = 0;
    this.pickupIdx = -1;
    switch (p.pickupPolicy) {
      case 'ignore':
        break;
      case 'ifWithinRange': {
        const idx = this.nearestActivePickup(delayed, sx, sz, p.pickupRangeM, hpFrac < 0.95);
        if (idx >= 0) {
          this.pickupIdx = idx;
          pickupScore = 0.55;
        }
        break;
      }
      case 'proactiveWhenSafe': {
        const safe = nearestDist > 8;
        const wantHeal = hpFrac < 0.7;
        const idx = wantHeal
          ? this.findPickup(delayed, 'heal')
          : safe
            ? this.nearestActivePickup(delayed, sx, sz, 15, hpFrac < 0.95)
            : -1;
        if (idx >= 0) {
          this.pickupIdx = idx;
          pickupScore = wantHeal ? 0.72 : 0.5;
        }
        break;
      }
      case 'contestAndDeny': {
        // Take when hurt; deny the heal when the (low) target needs it.
        if (hpFrac < 0.65 && healIdx >= 0) {
          this.pickupIdx = healIdx;
          pickupScore = 0.75;
        } else if (t !== null && t.hpFrac < 0.45 && healIdx >= 0) {
          const pad = delayed.pickups[healIdx];
          const dSelf = Math.hypot(pad.pos.x - sx, pad.pos.z - sz);
          const dTgt = Math.hypot(pad.pos.x - t.x, pad.pos.z - t.z);
          if (dTgt < 14 && dSelf < dTgt + 2) {
            this.pickupIdx = healIdx;
            pickupScore = 0.8;
          }
        } else if (nearestDist > 8 && hpFrac < 0.95) {
          const idx = this.nearestActivePickup(delayed, sx, sz, 12, true);
          if (idx >= 0) {
            this.pickupIdx = idx;
            pickupScore = 0.45;
          }
        }
        break;
      }
    }

    // Defend scores below engage-with-advantage: the block overlay raises the
    // guard regardless of goal; the goal itself only wins when we're passive.
    const defendScore = this.block.active(now) || this.block.pending(now) ? 0.68 : 0;
    const specialScore = this.wish.special ? 0.85 : 0;
    const ultScore = this.wish.ult ? 0.95 : 0;

    // Crowd's Bloodlust anti-stall (§6): as the ramp climbs, passivity stops
    // paying — press the fight instead of looping heals.
    if (delayed.bloodlustMult >= 1.5) {
      retreatScore *= 0.4;
      pickupScore *= 0.5;
    }

    // Hysteresis: the current goal gets +15% (§10.2).
    let bestGoal: Goal = 'engage';
    let bestScore = -1;
    const consider = (g: Goal, s: number): void => {
      if (g === this.goal) s *= 1 + AI_TUNING.currentGoalBonus;
      if (s > bestScore) {
        bestScore = s;
        bestGoal = g;
      }
    };
    consider('engage', engage);
    consider('retreat', retreatScore);
    consider('pickup', pickupScore);
    consider('defend', defendScore);
    consider('special', specialScore);
    consider('ultimate', ultScore);
    this.goal = bestGoal;
  }

  private findPickup(snap: WorldSnapshot, kind: 'heal' | 'speed' | 'rage'): number {
    let best = -1;
    let bestD = 1e9;
    const self = snap.fighters[this.id];
    const sx = self !== undefined ? self.pos.x : 0;
    const sz = self !== undefined ? self.pos.z : 0;
    for (let i = 0; i < snap.pickups.length; i++) {
      const pk = snap.pickups[i];
      if (!pk.active || pk.kind !== kind) continue;
      const d = Math.hypot(pk.pos.x - sx, pk.pos.z - sz);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private nearestActivePickup(
    snap: WorldSnapshot,
    sx: number,
    sz: number,
    maxDist: number,
    allowHeal: boolean,
  ): number {
    let best = -1;
    let bestD = maxDist;
    for (let i = 0; i < snap.pickups.length; i++) {
      const pk = snap.pickups[i];
      if (!pk.active) continue;
      if (pk.kind === 'heal' && !allowHeal) continue;
      const d = Math.hypot(pk.pos.x - sx, pk.pos.z - sz);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  // ── Executor (per tick, §10.3) ──────────────────────────────────────────────

  private execute(now: number, self: FighterState, current: WorldSnapshot): void {
    const intent = this.intent;
    const p = this.profile;
    const t = this.tracked(this.targetId);
    const sx = self.pos.x;
    const sz = self.pos.z;
    const move = this.move;
    move.x = 0;
    move.z = 0;
    intent.jump = false;

    // Predictive lead over own reaction latency (skilled bots only).
    const lead = p.strafeSkill >= 0.5 ? this.perception.reactionS * p.strafeSkill : 0;
    let tx = 0;
    let tz = 0;
    if (t !== null) {
      tx = t.x + t.velX * lead;
      tz = t.z + t.velZ * lead;
    }

    let wantAttack = false;
    let aimYaw = self.yaw;

    const disengaging = now < this.disengageUntil;
    const goal = disengaging ? 'retreat' : this.goal;

    switch (goal) {
      case 'special':
      case 'ultimate': {
        // Fire the edge once, keep engage movement underneath.
        if (goal === 'special' && this.wish.special && self.specialCd <= 0 && now >= this.lastSpecialPress + 0.3) {
          intent.special = true;
          this.lastSpecialPress = now;
          this.wish.special = false;
          aimYaw = this.wish.aimYaw;
        } else if (goal === 'ultimate' && this.wish.ult && self.ultCharge >= 100) {
          intent.ultimate = true;
          this.wish.ult = false;
          aimYaw = this.wish.aimYaw;
        } else {
          aimYaw = this.wish.aimYaw;
        }
        if (t !== null) this.engageMovement(move, self, t, tx, tz);
        if (!intent.special && !intent.ultimate) {
          // Edge already spent — behave as engage until the next decision.
          const r = this.engageAttack(now, self, t, tx, tz);
          wantAttack = Number.isFinite(r);
          if (wantAttack) aimYaw = r;
        }
        break;
      }

      case 'engage': {
        if (t !== null) {
          this.engageMovement(move, self, t, tx, tz);
          const r = this.engageAttack(now, self, t, tx, tz);
          wantAttack = Number.isFinite(r);
          aimYaw = wantAttack ? r : dirToYaw(tx - sx, tz - sz) + this.aimNoise;
        } else {
          // No live contact: chase the freshest memory, else drift to centre.
          const m = this.freshestMemory(now);
          if (m !== null) seek(move, sx, sz, m.x, m.z);
          else if (sx * sx + sz * sz > 36) seek(move, sx, sz, 0, 0);
          aimYaw = move.x !== 0 || move.z !== 0 ? dirToYaw(move.x, move.z) : self.yaw;
        }
        break;
      }

      case 'retreat': {
        const threat = t !== null ? t : this.freshestMemory(now);
        const healIdx = this.retreatHealIdx;
        if (healIdx >= 0 && current.pickups[healIdx] !== undefined && current.pickups[healIdx].active) {
          const pad = current.pickups[healIdx];
          seek(move, sx, sz, pad.pos.x, pad.pos.z);
        } else if (threat !== null) {
          if (p.retreat.losBreak) this.losBreakMove(move, sx, sz, threat);
          else flee(move, sx, sz, threat.x, threat.z);
        }
        if (threat !== null) {
          aimYaw = dirToYaw(threat.x - sx, threat.z - sz) + this.aimNoise;
          // Kite pokes: hit pursuers who enter range (kite modes only).
          if (
            (p.retreat.mode === 'kite' || p.retreat.mode === 'kiteAdvanced') &&
            threat.dist <= this.def.range + 0.06
          ) {
            wantAttack = true;
          }
        }
        // Eagle glides out (its §10 script's only sanctioned jump use).
        if (this.def.id === 'eagle' && disengaging) intent.jump = true;
        break;
      }

      case 'pickup': {
        const idx = this.pickupIdx;
        const pad = idx >= 0 ? current.pickups[idx] : undefined;
        if (pad !== undefined && pad.active) {
          seek(move, sx, sz, pad.pos.x, pad.pos.z);
          aimYaw =
            t !== null ? dirToYaw(t.x - sx, t.z - sz) + this.aimNoise : dirToYaw(move.x, move.z);
        } else {
          this.pickupIdx = -1;
          this.goal = 'engage';
        }
        break;
      }

      case 'defend': {
        // Face the threat, give ground slowly; block overlay below does the rest.
        aimYaw = this.block.yaw;
        move.x = -Math.sin(this.block.yaw) * 0.45;
        move.z = -Math.cos(this.block.yaw) * 0.45;
        break;
      }
    }

    // Panther stealth approach: swing around behind the target (§10 script).
    if (t !== null && this.def.id === 'panther' && p.specialUse === 'fullScripts') {
      let stealthed = false;
      for (let i = 0; i < self.buffs.length; i++) {
        if (self.buffs[i].kind === 'stealth') {
          stealthed = true;
          break;
        }
      }
      if (stealthed && t.dist > this.def.range * 0.8) {
        const bx = t.x - Math.sin(t.yaw) * 1.8;
        const bz = t.z - Math.cos(t.yaw) * 1.8;
        seek(move, sx, sz, bx, bz);
      }
    }

    // Detect incoming swings from the delayed view and schedule blocks.
    this.watchIncomingSwings(now, self);

    // Steering post-passes: obstacle feelers, local avoidance.
    const burrowed = false; // handled in driveChannel; normal flow is surface
    const jumpableAhead = avoidObstacles(move, sx, sz, this.def.radius, current.crates, burrowed);
    separation(move, self, current.fighters, this.targetId);
    if (jumpableAhead && p.strafeSkill >= 0.3 && (move.x !== 0 || move.z !== 0)) {
      this.jumpHoldUntil = Math.max(this.jumpHoldUntil, now + 0.35);
    }

    intent.moveX = move.x;
    intent.moveZ = move.z;
    intent.aimYaw = aimYaw;
    intent.jump = intent.jump || now < this.jumpHoldUntil;

    // Block overlay (cannot attack while blocking, §7.4). Skip when the guard
    // is nearly broken — eating a guard break is worse than a hit (L3+).
    const guardOk = p.whiffPunish ? self.guard > self.maxGuard * 0.15 : self.guard > 0;
    if (this.block.active(now) && !isAttackAction(self.action) && guardOk) {
      intent.block = true;
      intent.aimYaw = this.block.yaw;
      intent.attack = false;
      return;
    }
    intent.block = false;

    if (wantAttack && now >= this.lastAttackPress + 0.12 && now >= this.feintHoldUntil) {
      intent.attack = true;
      this.lastAttackPress = now;
      // Hit-and-run exit once the combo is spent (eagle script; panther when hurt).
      if (p.specialUse === 'fullScripts' && self.comboIndex === 2) {
        if (this.def.id === 'eagle') this.disengageUntil = now + 1.6;
        else if (this.def.id === 'panther' && this.sit.hpFrac < 0.6) this.disengageUntil = now + 1.2;
      }
    }
  }

  /** Engage-goal movement: close to spacing, then strafe-orbit per skill. */
  private engageMovement(move: Move2, self: FighterState, t: TrackedEnemy, tx: number, tz: number): void {
    const p = this.profile;
    const sx = self.pos.x;
    const sz = self.pos.z;
    const range = this.def.range;
    // Long-reach animals hold max-range spacing; the rest walk into the cut.
    const spacing =
      p.strafeSkill > 0.3
        ? this.def.id === 'giraffe' || this.def.id === 'python'
          ? range * 0.85
          : Math.max(0.9, range - 0.6)
        : range * 0.7;
    const dx = tx - sx;
    const dz = tz - sz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > spacing + 1.2 || p.strafeSkill <= 0.05) {
      seek(move, sx, sz, tx, tz);
      if (dist < spacing * 0.8) flee(move, sx, sz, tx, tz); // unskilled: back off overlap
    } else {
      orbit(move, sx, sz, t.x, t.z, this.orbitSign, spacing, p.strafeSkill);
    }
  }

  /**
   * Attack decision: returns a finite aim yaw when the bot should press
   * attack this tick, or `Number.NEGATIVE_INFINITY` when it should not.
   */
  private engageAttack(now: number, self: FighterState, t: TrackedEnemy | null, tx: number, tz: number): number {
    if (t === null) return Number.NEGATIVE_INFINITY;
    const p = this.profile;
    const sx = self.pos.x;
    const sz = self.pos.z;
    const dx = tx - sx;
    const dz = tz - sz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const punishing = now < this.punishUntil;
    // Full reach + a small pad: big bodies hold small animals at exactly
    // `range` (mole 1.7 vs hippo contact 1.7) — never swinging is worse than
    // an occasional edge whiff.
    const reach = this.def.range + (punishing ? 0.2 : 0.06);
    if (dist > reach) return Number.NEGATIVE_INFINITY;

    // Combo depth cap (§10 table). `comboIndex` is the LAST/CURRENT swing's
    // step (it stays stale after the combo lapses); a press CHAINS to
    // comboIndex+1 only while swinging or within the post-swing chain window
    // (`comboWindow` > 0). Outside those, a press starts a fresh hit1 —
    // always allowed.
    const chaining = isAttackAction(self.action) || self.comboWindow > 0;
    if (chaining && self.comboIndex + 1 >= p.comboDepth) return Number.NEGATIVE_INFINITY;

    // Don't mash into a raised block's front at L3+ — bait or flank (§10).
    // Only while their guard is healthy: once it's nearly cracked, smashing
    // through the block IS the play (guard break → 1.5 s stagger).
    const aimYaw = dirToYaw(dx, dz) + this.aimNoise;
    if (t.blocking && t.guardFrac > 0.45 && p.whiffPunish && !punishing) {
      const yawFromTargetToSelf = dirToYaw(sx - t.x, sz - t.z);
      const inFront = Math.abs(angleDelta(t.yaw, yawFromTargetToSelf)) <= 75 * DEG2RAD + 0.2;
      if (inFront) {
        if (p.baitsBlocks && now >= this.nextBaitPokeAt) {
          // Guard-drain poke, then hold off briefly.
          this.nextBaitPokeAt = now + 0.9;
          return aimYaw;
        }
        return Number.NEGATIVE_INFINITY; // flank via orbit instead
      }
    }
    return aimYaw;
  }

  /** Watch the delayed view for enemy swings; roll & schedule blocks / punishes. */
  private watchIncomingSwings(now: number, self: FighterState): void {
    const p = this.profile;
    const es = this.perception.enemies;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (i === self.id || !e.alive || !e.visible || !e.swingStarted) continue;
      const eDef = ANIMALS[e.animal];
      const yawToSelf = dirToYaw(self.pos.x - e.x, self.pos.z - e.z);
      const facingMe = Math.abs(angleDelta(e.yaw, yawToSelf)) <= (eDef.arcDeg * 0.5 + 20) * DEG2RAD;
      const inReach = e.dist <= eDef.range + 1.0;

      if (facingMe && inReach) {
        if (this.rng() < p.blockOnTelegraphChance) {
          const tti = Math.max(0.05, timeToImpact(e.actionT, e.actionDur));
          this.block.schedule(now, tti, yawToSelf + Math.PI, p.perfectBlockTry);
        }
      } else if (p.whiffPunish && i === this.targetId && !inReach && e.dist <= eDef.range + 2.5) {
        // They swung at air near us — committed recovery, go punish (§10).
        this.punishUntil = now + 0.8;
      }
    }
  }

  /** Freshest remembered contact (for pursuit when nothing is visible). */
  private freshestMemory(now: number): TrackedEnemy | null {
    let best: TrackedEnemy | null = null;
    let bestSeen = -1e9;
    const es = this.perception.enemies;
    for (let i = 0; i < es.length; i++) {
      const t = es[i];
      if (i === this.id || !t.alive) continue;
      if (now - t.lastSeen <= MEMORY_SECONDS && t.lastSeen > bestSeen) {
        bestSeen = t.lastSeen;
        best = t;
      }
    }
    return best;
  }

  /** Disengage while putting a pillar between self and the threat (Apex). */
  private losBreakMove(move: Move2, sx: number, sz: number, threat: TrackedEnemy): void {
    let best = -1;
    let bestD = 1e9;
    for (let i = 0; i < PILLARS.length; i++) {
      const p = PILLARS[i];
      // Prefer pillars roughly on the far side of us from the threat.
      const dx = p.x - sx;
      const dz = p.z - sz;
      const away = (sx - threat.x) * dx + (sz - threat.z) * dz;
      if (away <= 0) continue;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) {
      flee(move, sx, sz, threat.x, threat.z);
      return;
    }
    const p = PILLARS[best];
    // Cover point: pillar centre pushed away from the threat.
    const cx = p.x - threat.x;
    const cz = p.z - threat.z;
    const cl = Math.sqrt(cx * cx + cz * cz) || 1;
    seek(move, sx, sz, p.x + (cx / cl) * 2.4, p.z + (cz / cl) * 2.4);
  }

  /** Steering during our own ability channels (charges, burrow, soar). */
  private driveChannel(now: number, self: FighterState, action: 'special' | 'ultimate' | 'burrowed'): void {
    const intent = this.intent;
    const t = this.tracked(this.targetId);
    const sx = self.pos.x;
    const sz = self.pos.z;
    const move = this.move;
    move.x = 0;
    move.z = 0;
    intent.block = false;
    intent.jump = false;

    if (action === 'burrowed') {
      // Mole: tunnel to the target (obstacles ignored while underground),
      // erupt beneath them (re-press special) or just before the timer ends.
      if (t !== null) {
        seek(move, sx, sz, t.x, t.z);
        if ((t.dist <= 1.2 || self.burrowT <= 0.35) && now >= this.lastSpecialPress + 0.25) {
          intent.special = true;
          this.lastSpecialPress = now;
        }
      } else if (self.burrowT <= 0.35 && now >= this.lastSpecialPress + 0.25) {
        intent.special = true;
        this.lastSpecialPress = now;
      }
      intent.moveX = move.x;
      intent.moveZ = move.z;
      if (move.x !== 0 || move.z !== 0) intent.aimYaw = dirToYaw(move.x, move.z);
      return;
    }

    // Steer charges / channels toward the (predicted) target.
    if (t !== null) {
      const lead = this.profile.strafeSkill >= 0.5 ? this.perception.reactionS : 0;
      const tx = t.x + t.velX * lead;
      const tz = t.z + t.velZ * lead;
      intent.aimYaw = dirToYaw(tx - sx, tz - sz);
      seek(move, sx, sz, tx, tz);
    }
    intent.moveX = move.x;
    intent.moveZ = move.z;
  }
}

/**
 * Rhino Lockdown Charge geometry: is there a wall or pillar within charge
 * range directly beyond the target along the self→target line? (§10 script.)
 */
function wallBehindTarget(sx: number, sz: number, tx: number, tz: number): boolean {
  const dx = tx - sx;
  const dz = tz - sz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1e-6) return false;
  const nx = dx / dist;
  const nz = dz / dist;
  const remaining = 12 - dist; // charge covers 12 m total
  if (remaining < 1) return false;
  // Sample the carry path 1 m at a time.
  for (let s = 1; s <= remaining; s++) {
    const px = tx + nx * s;
    const pz = tz + nz * s;
    if (px * px + pz * pz >= (WALL_RADIUS - 1.4) * (WALL_RADIUS - 1.4)) return true;
    for (let i = 0; i < PILLARS.length; i++) {
      const p = PILLARS[i];
      const ox = px - p.x;
      const oz = pz - p.z;
      if (ox * ox + oz * oz <= (p.radius + 1.0) * (p.radius + 1.0)) return true;
    }
  }
  return false;
}
