/**
 * Champions League — static analysis of move data (no simulation). Used by
 * `tests/brawl/moveBudget.test.ts`, the balance pass, bots (move range/startup reads) and the
 * setup screen's mini stat bars. Everything here is a pure function of the data.
 */

import type { CharacterStats, HitboxDef, MoveBody, MoveData, MovesetDef } from '../types';
import { MOVE_IDS } from '../types';
import { PHYS } from '../config';

export const MAX_MOVE_FRAMES = 62;

export const totalFrames = (b: MoveBody): number => b.startup + b.active + b.recovery;

/** Number of times one hitbox can hit a single victim in one activation. */
export function hitsOf(h: HitboxDef): number {
  if (!h.multiHitInterval || h.multiHitInterval <= 0) return 1;
  return Math.floor((h.to - h.from - 1) / h.multiHitInterval) + 1;
}

/** Groups of hitboxes (default group = own index, offset to avoid colliding with explicit ids). */
export function groupsOf(b: MoveBody): Map<number, HitboxDef[]> {
  const groups = new Map<number, HitboxDef[]>();
  b.hitboxes.forEach((h, i) => {
    const g = h.group ?? 1000 + i;
    const arr = groups.get(g);
    if (arr) arr.push(h);
    else groups.set(g, [h]);
  });
  return groups;
}

/** Damage one victim can take from one activation: `base` without sweetspots, `max` with them. */
export function victimDamage(b: MoveBody): { base: number; max: number } {
  let base = 0;
  let max = 0;
  for (const hs of groupsOf(b).values()) {
    let gb = 0;
    let gm = 0;
    for (const h of hs) {
      const n = hitsOf(h);
      gb = Math.max(gb, h.damage * n);
      gm = Math.max(gm, h.damage * n * (h.sweet ? h.sweet.damageMult : 1));
    }
    base += gb;
    max += gm;
  }
  return { base, max };
}

/** Knockback factor used by the power index: `1 + baseKb/20 + kbGrowth/30`. */
export const kbFactor = (h: HitboxDef): number => 1 + h.baseKb / 20 + h.kbGrowth / 30;

/** Σ over hit groups of (best damage × hits × kbFactor). Sweetspots are not counted. */
export function bodyPower(b: MoveBody): number {
  let p = 0;
  for (const hs of groupsOf(b).values()) {
    let best = 0;
    for (const h of hs) best = Math.max(best, h.damage * hitsOf(h) * kbFactor(h));
    p += best;
  }
  return p;
}

/** Power per frame of one move slot (lightN counts its whole chain). */
export function movePower(m: MoveData): number {
  const bodies = [m.ground, ...(m.chain ?? [])];
  let p = 0;
  let f = 0;
  for (const b of bodies) {
    p += bodyPower(b);
    f += totalFrames(b);
  }
  return p / f;
}

/** Mean power-per-frame over the 8 slots. */
export function powerIndex(set: MovesetDef): number {
  let s = 0;
  for (const id of MOVE_IDS) s += movePower(set.moves[id]);
  return s / MOVE_IDS.length;
}

export interface RecoveryResult {
  /** Highest point reached relative to the start of the move (m), including the post-move coast. */
  peak: number;
  /** Horizontal travel (m, forward) at the end of the move. */
  dx: number;
  /** Net vertical travel at the end of the move. */
  dy: number;
  /** peak + 0.5·|dx| — the number the recovery ordering test compares. */
  score: number;
}

const GRAV = PHYS.gravity;
const DT = PHYS.dt;

/**
 * Integrates `motion` for a fighter starting still in the air: `set` windows overwrite the given
 * velocity components every frame, `add` windows add them; `gravity` scales gravity during the window.
 * Outside a window that sets vx the sim applies the neutral-stick air drag (x0.98/frame), mirrored here. After the move ends the fighter coasts up to
 * its apex under normal gravity (no air control).
 */
export function simulateRecovery(b: MoveBody, stats: Pick<CharacterStats, 'gravityMult'>): RecoveryResult {
  const total = totalFrames(b);
  let x = 0;
  let y = 0;
  let vx = 0;
  let vy = 0;
  let peak = 0;
  for (let f = 0; f < total; f++) {
    let gm = 1;
    let setX = false;
    for (const m of b.motion ?? []) {
      if (f < m.from || f >= m.to) continue;
      if (m.set) {
        if (m.vx !== undefined) {
          vx = m.vx;
          setX = true;
        }
        if (m.vy !== undefined) vy = m.vy;
      } else {
        if (m.vx !== undefined) {
          vx += m.vx;
          setX = true;
        }
        if (m.vy !== undefined) vy += m.vy;
      }
      if (m.gravity !== undefined) gm = m.gravity;
    }
    if (!setX) vx *= 0.98;
    vy -= GRAV * stats.gravityMult * gm * DT;
    x += vx * DT;
    y += vy * DT;
    peak = Math.max(peak, y);
  }
  const dx = x;
  const dy = y;
  if (vy > 0) peak = Math.max(peak, y + (vy * vy) / (2 * GRAV * stats.gravityMult));
  return { peak, dx, dy, score: peak + 0.5 * Math.abs(dx) };
}

// ── Kill-power model ─────────────────────────────────────────────────────────

/**
 * Data-level estimate of "does this launch leave the stage", mirroring the simulation rules (plan §2.2,
 * `config.ts`; every constant is read from `PHYS`): the victim is hit on the Broken Colosseum 4 m in from the
 * centre; during hitstun horizontal speed decays by `hitstunDecayX` per frame and gravity is x`hitstunGravityMult`;
 * afterwards the victim is in free fall and steers back toward the stage like a level-4 bot (air acceleration
 * `airAccel` toward `-airSpeed`, 2 % drag when above it, fall speed capped). No DI, no jumps, no air dodge — real
 * players and bots do a little better, so the real kill percent is later (WP-T: the model orders the animals like the
 * balance sweep and sits ~25-60 points below the measured mean KO percent of the move; sweetspots count half).
 * `tests/brawl/moveSmoke.test.ts` checks the same claim in the real `BrawlWorld` (re-run it if `PHYS` changes).
 */
export const KILL_MODEL = {
  startX: 4,
  startY: 0,
  blastRight: 30,
  blastTop: 22,
  blastBottom: -16,
  weight: 100,
  fallSpeed: 18,
  /** Steering back toward the stage after hitstun (m/s² and top speed, a mid-weight animal). */
  airAccel: 30,
  airSpeed: 6,
  /** A sweetspot is the full tip hit only part of the time: kill percent = plain + share x (sweet - plain). */
  sweetShare: 0.5,
};

export function launchSpeed(h: HitboxDef, pct: number, weight: number, sweet: boolean): number {
  const dmg = h.damage * (sweet && h.sweet ? h.sweet.damageMult : 1);
  const after = pct + dmg;
  const kbMult = sweet && h.sweet ? h.sweet.kbMult : 1;
  return Math.min(PHYS.kbCap, (h.baseKb + (h.kbGrowth * after) / 100) * kbMult * (100 / weight));
}

/** True when a launch of `kb` m/s at `angle`° (0 = toward the blast side, 90 = up) exits the blast zone. */
export function launchKills(kb: number, angleDeg: number, hitstunScale = 1): boolean {
  const a = (angleDeg * Math.PI) / 180;
  let vx = kb * Math.cos(a);
  let vy = kb * Math.sin(a);
  let x = KILL_MODEL.startX;
  let y = KILL_MODEL.startY;
  const stun = Math.max(PHYS.hitstunMin, Math.min(PHYS.hitstunMax, Math.floor(kb * PHYS.hitstunPerKb * hitstunScale)));
  for (let f = 0; f < 480; f++) {
    if (f < stun) {
      vx *= PHYS.hitstunDecayX;
      vy -= GRAV * PHYS.hitstunGravityMult * DT;
    } else {
      if (KILL_MODEL.airAccel > 0) {
        // the victim holds the stick toward the stage (-x): decelerate toward -airSpeed
        const target = -KILL_MODEL.airSpeed;
        const step = KILL_MODEL.airAccel * DT;
        vx = vx > target ? Math.max(target, vx - step) : Math.min(target, vx + step);
      } else vx *= PHYS.airDrag;
      vy = Math.max(vy - GRAV * DT, -KILL_MODEL.fallSpeed);
    }
    x += vx * DT;
    y += vy * DT;
    if (x >= KILL_MODEL.blastRight || y >= KILL_MODEL.blastTop) return true;
    if (y <= KILL_MODEL.blastBottom) return angleDeg > 180 && angleDeg < 360;
  }
  return false;
}

/** Lowest victim percent (weight `weight`) at which this hitbox's launch leaves the stage, or Infinity. */
export function killPercent(h: HitboxDef, weight = KILL_MODEL.weight, sweet = false): number {
  // spikes/buries/pulls are not stage-exit launches in this model
  if (h.effect === 'spike' || h.effect === 'bury' || h.effect === 'pull') return Infinity;
  // launch toward the blast side; angles > 90 mirror to the other side (same distance by symmetry)
  const ang = h.angle > 90 && h.angle <= 180 ? 180 - h.angle : h.angle;
  if (ang > 180) return Infinity;
  for (let pct = 0; pct <= 400; pct += 1) {
    const kb = launchSpeed(h, pct, weight, sweet);
    if (launchKills(kb, ang, h.hitstunScale ?? 1)) return pct;
  }
  return Infinity;
}

/** Best (lowest) kill percent of a body over its hitboxes (sweetspot counted at `sweetShare`). */
export function bodyKillPercent(b: MoveBody, weight = KILL_MODEL.weight): number {
  let best = Infinity;
  for (const h of b.hitboxes) {
    const plain = killPercent(h, weight, false);
    let v = plain;
    if (h.sweet) {
      const sw = killPercent(h, weight, true);
      v = plain === Infinity ? sw : plain + KILL_MODEL.sweetShare * (sw - plain);
    }
    best = Math.min(best, v);
  }
  return best;
}

// ── Reach / ratings ──────────────────────────────────────────────────────────

/** Furthest forward extent of any hitbox (m from the feet centre, including path travel and lunge motion). */
export function bodyReach(b: MoveBody): number {
  let reach = 0;
  for (const h of b.hitboxes) {
    const half = h.shape === 'circle' ? h.r : h.w / 2;
    const dxPath = h.path ? Math.max(0, ...h.path.map((k) => k.x)) : 0;
    reach = Math.max(reach, h.x + dxPath + half);
  }
  return reach;
}

/** Highest point of any hitbox (m above the feet), including path travel. */
export function bodyHeight(b: MoveBody): number {
  let top = 0;
  for (const h of b.hitboxes) {
    const half = h.shape === 'circle' ? h.r : h.h / 2;
    const dyPath = h.path ? Math.max(0, ...h.path.map((k) => k.y)) : 0;
    top = Math.max(top, h.y + dyPath + half);
  }
  return top;
}

export interface Ratings {
  /** 0..1 each, normalised against the roster's design range. */
  weight: number;
  speed: number;
  reach: number;
  recovery: number;
  power: number;
  raw: { weight: number; runSpeed: number; reach: number; recoveryScore: number; power: number };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Mini-stat bars for the character select (weight, speed, reach, recovery, power). */
export function ratings(set: MovesetDef): Ratings {
  const reaches = MOVE_IDS.map((id) => bodyReach(set.moves[id].ground));
  const reach = reaches.reduce((a, b) => a + b, 0) / reaches.length;
  const rec = simulateRecovery(set.moves.heavyU.ground, set.stats).score;
  const power = powerIndex(set);
  return {
    weight: clamp01((set.stats.weight - 70) / 75),
    speed: clamp01((set.stats.runSpeed - 6) / 4.2),
    reach: clamp01((reach - 1.2) / 2.0),
    recovery: clamp01((rec - 2.5) / 8),
    power: clamp01((power - 0.7) / 1.0),
    raw: { weight: set.stats.weight, runSpeed: set.stats.runSpeed, reach, recoveryScore: rec, power },
  };
}
