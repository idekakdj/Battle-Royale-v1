/**
 * Panther — Shadow Execution VFX (v1.3 Phase 2). The panther itself is ~80% transparent in shadow (shared stealth
 * fade), so the effects carry the read:
 *  - cast: a reticle tracks the victim (gold for the player's own hunt, red for an enemy's); dark smoke boils off the
 *    panther as it melts, and keeps trailing it for as long as the shadow lasts.
 *  - every blink: a violet dashed SHADOW MARK on the ground where the panther lands (fades over ~0.8 s), dark smoke
 *    trailing along the jump from the old spot to the new one, and the shared shadow-step flicker.
 *  - stages 1..5: a distinct violet slash streak per strike (rake / overhead / low sweep / lunge fangs / spinning X)
 *    timed to the claws landing; stage 6: the big two-paw X; stage 7: the EXECUTE flash (white-violet burst, shock
 *    ring, shake); stage 8: the panther steps out of the shadow in a puff of smoke.
 * Reuses {@link SlashPool} (camera-facing claw streaks) from the lion module.
 */

import * as THREE from 'three';
import { PANTHER_EXEC as E } from '../../config/ultimates/panther';
import type { Vec3 } from '../../core/types';
import { tierProfile } from '../quality';
import { disposeClawTexture, SlashPool } from './lion';
import type { ReticleHandle } from './primitives';
import type { UltFx, UltFxContext } from './types';

const VIOLET = 0x8a5cff;
const DEEP = 0x5a30c0;
const CORE = 0xf0e6ff;
/** The streaks use normal blending (dark body, bright violet-white edge) so they read on pale sand as well as in shade. */
const SLASH_DARK = 0x180a30;
const SLASH_EDGE = 0xd2b8ff;

interface Slot {
  reticle: ReticleHandle | null;
  targetId: number;
  t0: number;
  lead: number;
  nextSmoke: number;
}

interface Pending {
  at: number;
  run: () => void;
}

const slots: Slot[] = [];
const pending: Pending[] = [];
let pool: SlashPool | null = null;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

function slot(id: number): Slot {
  let s = slots[id];
  if (s === undefined) {
    s = { reticle: null, targetId: -1, t0: 0, lead: 0.4, nextSmoke: 0 };
    slots[id] = s;
  }
  return s;
}

function ensurePool(ctx: UltFxContext): SlashPool {
  if (pool === null) pool = new SlashPool(ctx.scene, 12, SLASH_DARK, SLASH_EDGE, false);
  return pool;
}

function later(ctx: UltFxContext, delay: number, run: () => void): void {
  pending.push({ at: ctx.time + delay, run });
}

/** Dark smoke puffs around (x, z), rising. */
function smoke(ctx: UltFxContext, x: number, y: number, z: number, n: number, spread = 0.6, rise = 1.1): void {
  const count = Math.max(1, Math.round(n * tierProfile().fxScale));
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = Math.random() * spread;
    ctx.effects.puff(x + Math.cos(a) * 0.25, y + Math.random() * 0.6, z + Math.sin(a) * 0.25, Math.cos(a) * sp, 0.3 + Math.random() * rise, Math.sin(a) * sp, 0.6 + Math.random() * 0.4, 0.45, 1.5, 0.07, 0.04, 0.12, 0.55, -0.3, 2);
  }
}

/** The violet slash for strike beat `stage` (1..6) landing on the victim at `at`. */
function slashFor(ctx: UltFxContext, stage: number, at: Vec3, from: Vec3): void {
  const p = ensurePool(ctx);
  // Sit the streak on the side of the victim the panther came from.
  const dx = from.x - at.x;
  const dz = from.z - at.z;
  const d = Math.max(0.001, Math.hypot(dx, dz));
  const x = at.x + (dx / d) * 0.3;
  const z = at.z + (dz / d) * 0.3;
  const y = at.y + 0.8;
  let n = 1;
  switch (stage) {
    case 1: // rake: diagonal
      p.spawn(x, y, z, 0.6, 1.9, 0.3);
      break;
    case 2: // overhead chop: near vertical
      p.spawn(x, y + 0.25, z, Math.PI / 2 + 0.12, 2.1, 0.3);
      break;
    case 3: // low sweep: flat and wide, near the ground
      p.spawn(x, at.y + 0.35, z, -0.08, 2.5, 0.3);
      break;
    case 4: // lunge-bite: converging fang marks
      p.spawn(x, y + 0.2, z, 1.2, 1.2, 0.28);
      p.spawn(x, y - 0.2, z, -1.2, 1.2, 0.28);
      n = 2;
      break;
    case 5: // spinning double rake: an X
      p.spawn(x, y, z, 0.75, 2.1, 0.3);
      p.spawn(x, y, z, Math.PI - 0.75, 2.1, 0.3);
      n = 2;
      break;
    default: // finisher: huge X + a vertical chop
      p.spawn(x, y, z, 0.65, 2.8, 0.42);
      p.spawn(x, y, z, Math.PI - 0.65, 2.8, 0.42);
      p.spawn(x, y + 0.1, z, Math.PI / 2, 2.4, 0.4);
      n = 3;
  }
  ctx.effects.burst({ x: at.x, y: at.y + 0.3, z: at.z }, VIOLET, 6 + n * 3, 5, 0.4, 0.1);
  ctx.effects.flash(at, 0.8, VIOLET, 0.5, 1.8 + n * 0.3, 0.14, 0.6, 1.4);
}

const pantherFx: UltFx = {
  onTarget(ctx, ev) {
    if (ev.kind !== 'lock') return;
    const s = slot(ev.fighterId);
    s.targetId = ev.targetId;
    s.t0 = ctx.time;
    s.lead = Math.max(0.2, ev.windup);
    s.nextSmoke = ctx.time;
    const mine = ctx.isPlayer(ev.fighterId);
    s.reticle = ctx.indicators.reticle(ev.fighterId);
    s.reticle.show(ev.to.x, 0, ev.to.z, 1.5, mine ? 'lock' : 'tracking');
    s.reticle.setColor(mine ? -1 : 0xb08cff);
    // Melt: a dark burst at the panther's feet.
    smoke(ctx, ev.from.x, 0.1, ev.from.z, 12, 1.0, 1.4);
    const ring = ctx.indicators.ring(ev.fighterId);
    ring.show(ev.from.x, 0, ev.from.z, 1.1, 0.14, 'friendly');
    ring.setColor(VIOLET);
    ring.setDash(8, 3);
    ring.hide(0.6);
  },

  onBlink(ctx, ev) {
    // Shadow-step flicker + dark smoke along the jump.
    ctx.effects.onBlink(ev.from, ev.to, DEEP);
    const dx = ev.to.x - ev.from.x;
    const dz = ev.to.z - ev.from.z;
    const dist = Math.hypot(dx, dz);
    const n = Math.max(3, Math.round((dist * 1.6) * tierProfile().fxScale));
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      ctx.effects.puff(ev.from.x + dx * k, ev.from.y + 0.35 + Math.random() * 0.7, ev.from.z + dz * k, (Math.random() - 0.5) * 0.6, 0.2 + Math.random() * 0.5, (Math.random() - 0.5) * 0.6, 0.5 + Math.random() * 0.3, 0.4, 1.15, 0.09, 0.05, 0.17, 0.5, -0.2, 2.4);
      if (i % 2 === 0) ctx.effects.spark(ev.from.x + dx * k, ev.from.y + 0.6, ev.from.z + dz * k, 0, 0.4, 0, 0.3, 0.1, 0.02, 0.55, 0.36, 1, 0.8, 0, 3);
    }
    // Shadow mark where it lands; fades on its own.
    const ring = ctx.indicators.ring(ev.fighterId);
    ring.show(ev.to.x, 0, ev.to.z, 1.0, 0.16, 'friendly');
    ring.setColor(VIOLET);
    ring.setDash(8, 3);
    ring.setGlow(1);
    later(ctx, 0.22, () => {
      if (ring.held(ev.fighterId)) ring.hide(0.6);
    });
  },

  onStage(ctx, ev) {
    const st = ev.stage;
    const panther: Vec3 = { x: ev.pos.x, y: ev.pos.y, z: ev.pos.z };
    if (st >= E.stage.strike0 && st <= E.stage.finisher) {
      const v = ctx.fighterPos(ev.targetId, _b);
      const at: Vec3 = { x: v.x, y: v.y, z: v.z };
      const delay = st === E.stage.finisher ? E.finisherImpactDelay : E.strikeImpactDelay;
      later(ctx, delay, () => {
        slashFor(ctx, st, at, panther);
        ctx.effects.addShake((st === E.stage.finisher ? 0.09 : 0.04) * ctx.nearness(at, 14));
      });
    } else if (st === E.stage.execute) {
      const v = ctx.fighterPos(ev.targetId, _a);
      const at: Vec3 = { x: v.x, y: v.y, z: v.z };
      ctx.effects.flash(at, 0.9, 0xffffff, 1.2, 4.6, 0.26, 0.85, 1.8);
      ctx.effects.flash(at, 0.9, VIOLET, 0.9, 3.4, 0.38, 0.7, 1.5);
      ctx.effects.shockRing({ x: at.x, y: 0, z: at.z }, VIOLET, 0.5, 5.2, 0.55, 1.5, 0.9);
      ctx.effects.impactRing({ x: at.x, y: 0, z: at.z }, 0.9, CORE, 0.3, 3.6, 0.4, 0.8);
      ctx.effects.burst({ x: at.x, y: at.y + 0.5, z: at.z }, CORE, 28, 8, 0.55, 0.12);
      ctx.effects.burst({ x: at.x, y: at.y + 0.5, z: at.z }, VIOLET, 20, 5.5, 0.6, 0.15);
      ctx.effects.addShake(0.16 * ctx.nearness(at, 18));
    } else if (st > E.stage.execute) {
      // Reappearance: a puff of smoke as the shadow lets go.
      smoke(ctx, panther.x, 0.1, panther.z, 8, 0.9, 0.8);
      ctx.effects.shockRing({ x: panther.x, y: 0, z: panther.z }, DEEP, 0.3, 1.6, 0.35, 1.2, 0.6);
    }
  },

  onFrame(ctx, snap, dt) {
    const now = ctx.time;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (now >= pending[i].at) {
        const run = pending[i].run;
        pending.splice(i, 1);
        run();
      }
    }
    if (pool !== null) pool.update(ctx.camera, dt);
    for (let id = 0; id < slots.length; id++) {
      const s = slots[id];
      if (s === undefined || s.targetId < 0) continue;
      const f = snap.fighters[id];
      if (f === undefined) continue;
      const stage = f.ultStage ?? 0;
      ctx.fighterPos(id, _a);
      ctx.fighterPos(s.targetId, _b);
      if (s.reticle !== null) {
        if (!s.reticle.held(id)) s.reticle = null;
        else if (stage >= E.stage.finisher || f.ultPhase === 'recovery') {
          s.reticle.hide(0.25);
          s.reticle = null;
        } else {
          s.reticle.update(_b.x, 0, _b.z, 1.5);
          if (f.ultPhase === 'active') {
            if (s.reticle.style !== 'committed') s.reticle.setStyle('committed');
            s.reticle.setCommit(Math.min(1, (stage + 1) / 6));
          } else s.reticle.setCommit(Math.min(0.9, (now - s.t0) / s.lead));
        }
      }
      // Smoke boils off the panther while it is in shadow (windup + strikes), so its position reads at 20% opacity.
      if ((f.ultPhase === 'windup' || f.ultPhase === 'active') && now >= s.nextSmoke) {
        s.nextSmoke = now + 0.09 / Math.max(0.4, tierProfile().fxScale);
        ctx.effects.puff(_a.x + (Math.random() - 0.5) * 0.6, _a.y + 0.2 + Math.random() * 0.7, _a.z + (Math.random() - 0.5) * 0.6, 0, 0.5 + Math.random() * 0.4, 0, 0.5, 0.4, 1.0, 0.08, 0.045, 0.15, 0.42, -0.2, 2);
      }
    }
  },

  onEnd(_ctx, fighterId) {
    const s = slots[fighterId];
    if (s !== undefined) {
      s.targetId = -1;
      s.reticle = null;
    }
  },

  dispose() {
    slots.length = 0;
    pending.length = 0;
    if (pool !== null) pool.dispose();
    pool = null;
    disposeClawTexture();
  },
};

export default pantherFx;
