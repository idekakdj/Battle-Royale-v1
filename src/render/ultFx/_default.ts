/**
 * Generic ultimate indicator (v1.3 WP-T) — what an animal WITHOUT its own
 * `src/render/ultFx/<animal>.ts` module gets when the sim emits `ultimateTarget`:
 *
 *   lock   → ribbon caster → victim + tracking reticle that follows the victim
 *   line   → ribbon (width = ev.width) start → end
 *   ground → zone at the target point (warning fill grows over the windup) + ribbon
 *
 * Markers live for the windup (+ a short grace) and are dropped on `onEnd`.
 * Per-animal modules replace it entirely; they can also delegate to it:
 * `import { defaultUltFx } from './_default'` (underscore files are not part of
 * the registry).
 */

import * as THREE from 'three';
import type { GameEventOf } from '../../core/types';
import type { ReticleHandle, RibbonHandle, ZoneHandle } from './primitives';
import type { UltFx } from './types';

const MAX = 16;
const GRACE = 0.35;
const TARGET_RING_R = 1.5;

interface Slot {
  id: number;
  kind: GameEventOf<'ultimateTarget'>['kind'];
  targetId: number;
  ribbon: RibbonHandle | null;
  reticle: ReticleHandle | null;
  zone: ZoneHandle | null;
  t0: number;
  windup: number;
  endAt: number;
  toX: number;
  toZ: number;
  width: number;
}

const slots: Slot[] = [];
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

function slotFor(id: number): Slot | null {
  if (id < 0 || id >= MAX) return null;
  let s = slots[id];
  if (s === undefined) {
    s = {
      id, kind: 'self', targetId: -1, ribbon: null, reticle: null, zone: null,
      t0: 0, windup: 0, endAt: -1, toX: 0, toZ: 0, width: 0,
    };
    slots[id] = s;
  }
  return s;
}

function clear(s: Slot): void {
  // A dry pool can steal a handle; only hide the ones we still hold.
  if (s.ribbon !== null && s.ribbon.held(s.id)) s.ribbon.hide();
  if (s.reticle !== null && s.reticle.held(s.id)) s.reticle.hide();
  if (s.zone !== null && s.zone.held(s.id)) s.zone.hide();
  s.ribbon = null;
  s.reticle = null;
  s.zone = null;
  s.endAt = -1;
}

export const defaultUltFx: UltFx = {
  onTarget(ctx, ev) {
    const s = slotFor(ev.fighterId);
    if (s === null || ev.kind === 'self') return;
    clear(s);
    const style = ctx.styleFor(ev.fighterId);
    s.kind = ev.kind;
    s.targetId = ev.targetId;
    s.t0 = ctx.time;
    s.windup = Math.max(0.1, ev.windup);
    s.endAt = ctx.time + s.windup + GRACE;
    s.toX = ev.to.x;
    s.toZ = ev.to.z;
    s.width = ev.width;
    const w = ev.kind === 'line' ? Math.max(0.6, ev.width) : ev.kind === 'ground' ? 0.35 : 0.5;
    s.ribbon = ctx.indicators.ribbon(ev.fighterId);
    s.ribbon.show(ev.from.x, 0, ev.from.z, ev.to.x, 0, ev.to.z, w, style);
    if (ev.kind === 'lock') {
      s.reticle = ctx.indicators.reticle(ev.fighterId);
      s.reticle.show(ev.to.x, 0, ev.to.z, TARGET_RING_R, ctx.isPlayer(ev.fighterId) ? 'lock' : 'tracking');
    } else if (ev.kind === 'ground') {
      s.zone = ctx.indicators.zone(ev.fighterId);
      s.zone.show(ev.to.x, 0, ev.to.z, Math.max(0.5, ev.width * 0.5), style);
    }
  },

  onFrame(ctx) {
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s === undefined || s.endAt < 0) continue;
      if (ctx.time > s.endAt) {
        clear(s);
        continue;
      }
      ctx.fighterPos(s.id, _p);
      let tx = s.toX;
      let tz = s.toZ;
      if (s.kind === 'lock' && s.targetId >= 0) {
        ctx.fighterPos(s.targetId, _q);
        tx = _q.x;
        tz = _q.z;
      }
      if (s.ribbon !== null && s.ribbon.held(s.id)) {
        s.ribbon.update(_p.x, 0, _p.z, tx, 0, tz, s.kind === 'line' ? Math.max(0.6, s.width) : s.kind === 'ground' ? 0.35 : 0.5);
      }
      const p = Math.min(1, (ctx.time - s.t0) / s.windup);
      if (s.reticle !== null && s.reticle.held(s.id)) {
        s.reticle.update(tx, 0, tz, TARGET_RING_R);
        if (p > 0.7 && s.reticle.style !== 'committed') s.reticle.setStyle('committed');
        s.reticle.setCommit(p);
      }
      if (s.zone !== null && s.zone.held(s.id)) s.zone.setProgress(p);
    }
  },

  onEnd(_ctx, fighterId) {
    const s = slotFor(fighterId);
    if (s !== null) clear(s);
  },

  dispose() {
    slots.length = 0;
  },
};
