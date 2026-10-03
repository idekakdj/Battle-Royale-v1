/**
 * Champions League bots — physics knowledge. A cheap kinematic model of the air physics the
 * simulation uses (gravity, air control, jumps, Heavy-Up motion, ledge box), used to PLAN a recovery,
 * pick directional influence and estimate whether a launch kills. The bot only ever calls these on
 * what it can see (snapshot values), the way a player eyeballs "can I make it back".
 */

import type { CharacterStats, MoveBody } from '../types';
import { StageInfo, supportedBy } from './stageInfo';

const DT = 1 / 60;
const GRAV = 38;
const EPS = 1e-4;

// grab box (mirrors PHYS in src/brawl/config.ts: the bot knows how the ledge works)
export const LEDGE_OUT = 0.8;
export const LEDGE_IN = 0.1;
export const LEDGE_UP = 0.4;
export const LEDGE_DOWN = 1.0;
export const HAND_FRAC = 0.95;
const GRAB_MAX_VY = 0.5;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function moveToward(v: number, target: number, rate: number): number {
  return v < target ? (v + rate > target ? target : v + rate) : v - rate < target ? target : v - rate;
}

/** Stick value (−1..1) that steers the air velocity toward the point `tx` (a velocity-command P controller). */
export function steerTo(x: number, vx: number, tx: number, airSpeed: number): number {
  const err = tx - x;
  const want = clamp(err * 2.2 - vx * 0.15, -airSpeed, airSpeed);
  const s = want / airSpeed;
  return Math.abs(s) < 0.1 ? 0 : clamp(s, -1, 1);
}

// ── ledge targets ────────────────────────────────────────────────────────────

/** The point (feet centre) in the middle of the ledge grab box of a ledge. */
export function ledgeSpot(cornerX: number, side: -1 | 1, platY: number, st: CharacterStats): { x: number; y: number } {
  const hw = st.width * 0.5;
  return { x: cornerX + side * (hw + 0.35), y: platY - 0.3 - st.height * HAND_FRAC };
}

// ── flight (being launched) ──────────────────────────────────────────────────

export interface FlightResult {
  /** Left the blast zone. */
  kill: boolean;
  /** Landed on a platform (or hit the stage body). */
  landed: boolean;
  /** Frames simulated until the outcome. */
  frames: number;
  /** Smallest distance to a blast line over the flight (m; negative once outside). */
  margin: number;
}

const flightOut: FlightResult = { kill: false, landed: false, frames: 0, margin: 99 };

/**
 * Where does a launch end? Hitstun physics for `stun` frames (×0.985 horizontal decay, gravity ×0.85), then plain free fall
 * with the 2 % air drag and no steering. `diDeg` rotates the initial velocity (directional influence, the caller's choice).
 * Returns a shared scratch object.
 */
export function flight(
  stage: StageInfo,
  x0: number,
  y0: number,
  vx0: number,
  vy0: number,
  stun: number,
  gm: number,
  fallSpeed: number,
  width: number,
  diDeg = 0,
): FlightResult {
  let vx = vx0;
  let vy = vy0;
  if (diDeg !== 0) {
    const r = (diDeg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    vx = vx0 * c - vy0 * s;
    vy = vx0 * s + vy0 * c;
  }
  let x = x0;
  let y = y0;
  const b = stage.blast;
  let margin = 99;
  let kill = false;
  let landed = false;
  let f = 0;
  for (; f < 360; f++) {
    if (f < stun) {
      vx *= 0.985;
      vy -= GRAV * 0.85 * gm * DT;
    } else {
      vx *= 0.98;
      vy -= GRAV * gm * DT;
      if (vy < -fallSpeed) vy = vy + (-fallSpeed - vy) * 0.25;
    }
    const nx = x + vx * DT;
    const ny = y + vy * DT;
    if (vy < 0) {
      for (const p of stage.plats) {
        if (y >= p.y - EPS && ny <= p.y + EPS && supportedBy(nx, width, p.x0, p.x1)) {
          landed = true;
          break;
        }
      }
      if (landed) break;
    }
    for (const p of stage.plats) {
      if (!p.solid) continue;
      if (nx > p.x0 && nx < p.x1 && ny < p.y && ny > p.y - p.thickness) {
        landed = true;
        break;
      }
    }
    if (landed) break;
    x = nx;
    y = ny;
    const m = Math.min(x - b.left, b.right - x, b.top - y, y - b.bottom);
    if (m < margin) margin = m;
    if (m < 0) {
      kill = true;
      break;
    }
  }
  flightOut.kill = kill;
  flightOut.landed = landed;
  flightOut.frames = f;
  flightOut.margin = margin;
  return flightOut;
}

// ── recovery planning ────────────────────────────────────────────────────────

export interface RecState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Air jumps left. */
  jumps: number;
  recoveryUsed: boolean;
  /** Frames until a ledge can be grabbed again. */
  ledgeCd: number;
  facing: 1 | -1;
  /** Stuck in free-fall after an air dodge (no jump / attack). */
  freeFall: boolean;
}

export interface RecPolicy {
  /** Steering target x. */
  tx: number;
  /** Air-jump when y <= jumpY and not rising. */
  jumpY: number;
  /** Heavy-Up when y <= heavyY. */
  heavyY: number;
  /** Only start Heavy-Up once the air jumps are spent. */
  heavyLast: boolean;
  /** Hold jump to glide (Eagle). */
  glide: boolean;
}

export interface RecResult {
  ok: boolean;
  kind: 'ledge' | 'land' | 'fail';
  frames: number;
  /** Index into `stage.ledges` when kind === 'ledge'. */
  ledge: number;
  /** Platform index when kind === 'land'. */
  plat: number;
  usedJump: boolean;
  usedHeavy: boolean;
  /** 0 nothing, 1 jump, 2 Heavy-Up as the very first thing the policy does. */
  first: 0 | 1 | 2;
  endX: number;
  endY: number;
}

const recOut: RecResult = { ok: false, kind: 'fail', frames: 0, ledge: -1, plat: -1, usedJump: false, usedHeavy: false, first: 0, endX: 0, endY: 0 };

export interface RecEnv {
  stage: StageInfo;
  stats: CharacterStats;
  /** Air-form Heavy-Up body of this animal. */
  rec: MoveBody;
  /** Ledges (indices into stage.ledges) that are free to grab. */
  freeLedge: (i: number) => boolean;
}

/**
 * Forward-simulates the fighter's own air physics under a simple resource policy until it grabs a free ledge,
 * lands on a platform, or is lost. Mirrors BrawlWorld's air step (air control, jump, Heavy-Up motion windows,
 * landing sweep, ledge grab box) closely enough to decide WHEN to spend jumps and Heavy-Up.
 */
export function simRecovery(env: RecEnv, s0: RecState, pol: RecPolicy, maxFrames = 200): RecResult {
  const { stage, stats, rec } = env;
  const hw = stats.width * 0.5;
  const h = stats.height;
  let x = s0.x;
  let y = s0.y;
  let vx = s0.vx;
  let vy = s0.vy;
  let jumps = s0.jumps;
  let recUsed = s0.recoveryUsed;
  let ledgeCd = s0.ledgeCd;
  let facing = s0.facing;
  let atk = -1;
  let usedJump = false;
  let usedHeavy = false;
  let first: 0 | 1 | 2 = 0;
  let decided = false;
  const total = rec.startup + rec.active + rec.recovery;
  const blast = stage.blast;
  recOut.ok = false;
  recOut.kind = 'fail';
  recOut.ledge = -1;
  recOut.plat = -1;
  for (let f = 0; f < maxFrames; f++) {
    if (ledgeCd > 0) ledgeCd--;
    let inX = steerTo(x, vx, pol.tx, stats.airSpeed);
    if (Math.abs(pol.tx - x) > 0.6) facing = pol.tx > x ? 1 : -1;
    let setX = false;
    let setY = false;
    let gmMove = 1;
    let inAttack = atk >= 0;
    if (!inAttack && !s0.freeFall) {
      // policy decisions (updateFree order: attack start, then jump)
      const jumpOk = jumps > 0 && y <= pol.jumpY && vy <= 1.0;
      const heavyOk = !recUsed && y <= pol.heavyY && vy <= 1.0 && (!pol.heavyLast || jumps === 0);
      const doHeavy = pol.heavyLast ? !jumpOk && heavyOk : heavyOk;
      const doJump = !doHeavy && jumpOk;
      if (doHeavy) {
        atk = 0;
        recUsed = true;
        usedHeavy = true;
        inAttack = true;
        if (!decided) first = 2;
        decided = true;
      } else if (doJump) {
        jumps--;
        vy = stats.airJumpVel;
        usedJump = true;
        if (!decided) first = 1;
        decided = true;
      }
    }
    if (inAttack) {
      const mf = atk;
      if (rec.motion) {
        for (const m of rec.motion) {
          if (mf < m.from || mf >= m.to) continue;
          const mvx = m.vx !== undefined ? m.vx * facing : 0;
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
          if (m.gravity !== undefined) gmMove = m.gravity;
        }
      }
      if (!setX) {
        const ax = Math.abs(inX);
        if (ax >= 0.1) {
          if (Math.abs(vx) > stats.airSpeed && Math.sign(vx) === Math.sign(inX)) vx *= 0.98;
          else vx = moveToward(vx, inX * stats.airSpeed, stats.airAccel * DT * 0.5);
        } else vx *= 0.98;
      }
    } else {
      const ax = Math.abs(inX);
      if (ax >= 0.1) {
        if (Math.abs(vx) > stats.airSpeed && Math.sign(vx) === Math.sign(inX)) vx *= 0.98;
        else vx = moveToward(vx, inX * stats.airSpeed, stats.airAccel * DT);
      } else vx *= 0.98;
    }
    // gravity + cap
    let cap = stats.fallSpeed;
    if (!inAttack && pol.glide && stats.glideFall !== undefined && vy <= 0 && stats.glideFall < cap) cap = stats.glideFall;
    vy -= GRAV * stats.gravityMult * (inAttack ? gmMove : 1) * DT;
    const capEff = setY ? Infinity : cap;
    if (capEff !== Infinity && vy < -capEff) {
      const ex = -capEff - vy;
      vy = ex <= 1.2 ? -capEff : vy + ex * 0.25;
    }
    // horizontal move with solid sides
    const oldY = y;
    let nx = x + vx * DT;
    for (const p of stage.plats) {
      if (!p.solid) continue;
      if (!(oldY < p.y - EPS && oldY + h > p.y - p.thickness + EPS)) continue;
      const was = x + hw > p.x0 + EPS && x - hw < p.x1 - EPS;
      const now = nx + hw > p.x0 && nx - hw < p.x1;
      if (!now) continue;
      if (!was) {
        nx = vx > 0 ? p.x0 - hw : p.x1 + hw;
        vx = 0;
      }
    }
    x = nx;
    let ny = oldY + vy * DT;
    // landing sweep
    let landIdx = -1;
    let landY = -Infinity;
    for (let i = 0; i < stage.plats.length; i++) {
      const p = stage.plats[i];
      if (!supportedBy(x, stats.width, p.x0, p.x1)) continue;
      if (oldY - p.y >= -EPS && ny - p.y <= EPS && p.y > landY) {
        landIdx = i;
        landY = p.y;
      }
    }
    if (landIdx >= 0) {
      recOut.ok = true;
      recOut.kind = 'land';
      recOut.plat = landIdx;
      recOut.frames = f;
      recOut.usedJump = usedJump;
      recOut.usedHeavy = usedHeavy;
      recOut.first = first;
      recOut.endX = x;
      recOut.endY = landY;
      return recOut;
    }
    if (vy > 0) {
      for (const p of stage.plats) {
        if (!p.solid) continue;
        if (!(x + hw > p.x0 && x - hw < p.x1)) continue;
        const bottom = p.y - p.thickness;
        if (oldY + h <= bottom + EPS && ny + h > bottom) {
          ny = bottom - h;
          vy = 0;
        }
      }
    }
    y = ny;
    if (inAttack) {
      atk++;
      if (atk >= total) atk = -1;
    } else if (ledgeCd <= 0 && vy <= GRAB_MAX_VY) {
      const hy = y + h * HAND_FRAC;
      for (let li = 0; li < stage.ledges.length; li++) {
        if (!env.freeLedge(li)) continue;
        const L = stage.ledges[li];
        const p = stage.plats[L.plat];
        const near = x - L.side * hw;
        const lo = L.side < 0 ? L.x - LEDGE_OUT : L.x - LEDGE_IN;
        const hi = L.side < 0 ? L.x + LEDGE_IN : L.x + LEDGE_OUT;
        if (near < lo || near > hi) continue;
        if (hy < p.y - LEDGE_DOWN || hy > p.y + LEDGE_UP) continue;
        recOut.ok = true;
        recOut.kind = 'ledge';
        recOut.ledge = li;
        recOut.frames = f;
        recOut.usedJump = usedJump;
        recOut.usedHeavy = usedHeavy;
        recOut.first = first;
        recOut.endX = x;
        recOut.endY = y;
        return recOut;
      }
    }
    if (y < blast.bottom || y > blast.top || x < blast.left || x > blast.right) break;
  }
  recOut.frames = maxFrames;
  recOut.usedJump = usedJump;
  recOut.usedHeavy = usedHeavy;
  recOut.first = first;
  recOut.endX = x;
  recOut.endY = y;
  return recOut;
}
