/**
 * EXAMPLE per-animal ultimate VFX module (v1.3 WP-T). NOT registered: the
 * leading underscore keeps it out of the `import.meta.glob` registry.
 *
 * To make a real one, copy this file to `src/render/ultFx/<animal>.ts`
 * (e.g. `lion.ts`) — the animal id as file name is what registers it — and
 * keep `export default`. Recipe:
 *
 *  1. `onTarget`  — the sim resolved the target at cast start. Reserve pooled
 *                   markers from `ctx.indicators` with `owner = ev.fighterId`
 *                   (they are auto-faded when that fighter's ultimate ends), and
 *                   `show(...)` them. Keep the handles in module-level slots.
 *  2. `onFrame`   — every render frame: follow moving things (`ctx.fighterPos`
 *                   gives the interpolated position of any fighter), advance
 *                   progress (`reticle.setCommit`, `ribbon.setReveal`, …).
 *                   Check `handle.held(id)` first: a dry pool steals the oldest.
 *  3. `onStage`   — a discrete beat (`ultimateStage`): puff / flash / shake with
 *                   `ctx.effects` (spark, puff, burst, flash, shockRing, crack …).
 *  4. `onBlink`, `onImpact` — panther shadow-steps / gorilla boulder landing.
 *  5. `onEnd`     — drop your per-fighter state (handles are auto-faded).
 *
 * This example: a lock-on ultimate with a bounding pounce. A gold (player) /
 * red (enemy) reticle tracks the victim, a dashed arc shows the leap path, and
 * every stage beat gets a ring + sparks.
 */

import * as THREE from 'three';
import type { ArcHandle, ReticleHandle } from './primitives';
import type { UltFx } from './types';

interface Slot {
  reticle: ReticleHandle | null;
  arc: ArcHandle | null;
  targetId: number;
  t0: number;
  windup: number;
}

const slots: Slot[] = [];
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

function slot(id: number): Slot {
  let s = slots[id];
  if (s === undefined) {
    s = { reticle: null, arc: null, targetId: -1, t0: 0, windup: 0 };
    slots[id] = s;
  }
  return s;
}

const example: UltFx = {
  onTarget(ctx, ev) {
    if (ev.kind !== 'lock') return;
    const s = slot(ev.fighterId);
    s.targetId = ev.targetId;
    s.t0 = ctx.time;
    s.windup = Math.max(0.1, ev.windup);
    const mine = ctx.isPlayer(ev.fighterId);
    s.reticle = ctx.indicators.reticle(ev.fighterId);
    s.reticle.show(ev.to.x, 0, ev.to.z, 1.5, mine ? 'lock' : 'tracking');
    s.arc = ctx.indicators.arc(ev.fighterId);
    s.arc.show(ev.from.x, 1, ev.from.z, ev.to.x, 1, ev.to.z, 2.2, 0.26, ctx.styleFor(ev.fighterId));
  },

  onFrame(ctx) {
    for (let id = 0; id < slots.length; id++) {
      const s = slots[id];
      if (s === undefined || s.targetId < 0) continue;
      ctx.fighterPos(id, _a);
      ctx.fighterPos(s.targetId, _b);
      if (s.reticle !== null && s.reticle.held(id)) {
        s.reticle.update(_b.x, 0, _b.z, 1.5);
        const p = Math.min(1, (ctx.time - s.t0) / s.windup);
        if (p > 0.6 && s.reticle.style !== 'committed') s.reticle.setStyle('committed');
        s.reticle.setCommit(p);
      }
      if (s.arc !== null && s.arc.held(id)) s.arc.update(_a.x, 1, _a.z, _b.x, 1, _b.z, 2.2);
    }
  },

  onStage(ctx, ev) {
    ctx.effects.shockRing(ev.pos, 0xd9a441, 0.4, 2.6, 0.35);
    ctx.effects.burst(ev.pos, 0xffc060, 14, 5);
    ctx.effects.addShake(0.04 * ctx.nearness(ev.pos, 14));
  },

  onEnd(_ctx, fighterId) {
    const s = slots[fighterId];
    if (s !== undefined) {
      s.targetId = -1;
      s.reticle = null;
      s.arc = null;
    }
  },

  dispose() {
    slots.length = 0;
  },
};

export default example;
