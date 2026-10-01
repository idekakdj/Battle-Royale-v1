/**
 * Quick-start match demo (`?demo=match&animal=lion&difficulty=4&seed=123`),
 * v1.2 WP-P: mounts a real {@link MatchController} straight away (no menus) so
 * traps, landing slams and the swing-sector / range-indicator work can be
 * verified in live play. `window.__gkMatch` exposes the controller for
 * inspection from the console. Results / quit simply restart the match.
 */

import { registerDemo } from '../core/demos';
import type { AnimalId, Difficulty, GameEvent } from '../core/types';
import type { EventBus } from '../core/EventBus';
import { ANIMALS, ANIMAL_IDS } from '../config/animals';
import { AudioEngine } from '../audio/AudioEngine';
import { MatchController } from './MatchController';

function ensureCanvas(): HTMLCanvasElement {
  const existing = document.getElementById('gk-canvas');
  if (existing instanceof HTMLCanvasElement) return existing;
  const canvas = document.createElement('canvas');
  canvas.id = 'gk-canvas';
  document.body.insertBefore(canvas, document.body.firstChild);
  return canvas;
}

registerDemo('match', (root) => {
  const params = new URLSearchParams(window.location.search);
  const a = params.get('animal');
  const animal: AnimalId = a !== null && (ANIMAL_IDS as readonly string[]).includes(a) ? (a as AnimalId) : 'lion';
  const d = Number(params.get('difficulty') ?? 4);
  const difficulty = (d >= 1 && d <= 4 ? Math.round(d) : 4) as Difficulty;
  const s = Number(params.get('seed'));
  let seed = Number.isFinite(s) && s > 0 ? s : Date.now();
  const canvas = ensureCanvas();
  const audio = new AudioEngine();
  let mc: MatchController | null = null;

  const start = (): void => {
    mc?.unmount();
    mc = new MatchController({
      canvas,
      audio,
      animal,
      difficulty,
      seed,
      onMatchEnd: () => {
        seed += 1;
        start();
      },
      onQuitToLobby: () => start(),
    });
    mc.mount(root);
    mc.debugProjectiles = [];
    (window as unknown as { __gkMatch?: MatchController }).__gkMatch = mc;
  };
  start();
  installUltTestHooks(() => mc);

  return () => {
    mc?.unmount();
    mc = null;
    delete (window as unknown as { __gkMatch?: MatchController }).__gkMatch;
    delete (window as unknown as { __gkMatchTest?: unknown }).__gkMatchTest;
    audio.dispose();
  };
});

/**
 * v1.3 WP-T QA hooks (`window.__gkMatchTest`, demo only): stage the ultimate
 * targeting UI without waiting for the sim to emit the events.
 *  - `boulder(fromX, fromZ, toX, toZ, speed?)` throws a ballistic boulder (drawn
 *    via `debugProjectiles`, then a real `projectileImpact` on the bus)
 *  - `blink(id, x, z)` teleports a fighter and emits `blink` (interpolation snap)
 *  - `fizzle()` emits the player's `ultimateFizzle`
 *  - `emit(event)` emits any GameEvent on the match bus
 *  - `place(id, x, z)` moves a fighter (sim state) without any event
 */
interface DemoWorld {
  fighters: { state: { pos: { x: number; y: number; z: number } } }[];
}

function installUltTestHooks(getMc: () => MatchController | null): void {
  const bus = (): EventBus | null => {
    const mc = getMc();
    return mc === null ? null : (mc as unknown as { bus: EventBus }).bus;
  };
  const world = (): DemoWorld | null => {
    const mc = getMc();
    return mc === null ? null : (mc as unknown as { world: DemoWorld }).world;
  };
  let nextId = 900;
  const hooks = {
    /** The live config table: tests can temporarily give an ultimate a `targeting` block. */
    animals: ANIMALS,
    boulder(fromX: number, fromZ: number, toX: number, toZ: number, speed = 18): void {
      const mc = getMc();
      if (mc === null || mc.debugProjectiles === null) return;
      const list = mc.debugProjectiles;
      const dx = toX - fromX;
      const dz = toZ - fromZ;
      const dist = Math.hypot(dx, dz);
      const T = Math.max(0.3, dist / speed);
      const g = 31 / (T * T); // ~5 m apex whatever the (slow-motion) speed
      const y0 = 2.2;
      const vy0 = (0 - y0 + 0.5 * g * T * T) / T;
      const p = {
        id: nextId++,
        kind: 'boulder' as const,
        pos: { x: fromX, y: y0, z: fromZ },
        vel: { x: dx / T, y: vy0, z: dz / T },
        radius: 0.7,
        ownerId: 0,
      };
      list.push(p);
      const dt = 1 / 60;
      const timer = window.setInterval(() => {
        p.pos.x += p.vel.x * dt;
        p.pos.y += p.vel.y * dt;
        p.pos.z += p.vel.z * dt;
        p.vel.y -= g * dt;
        if (p.pos.y <= 0.35 || getMc() === null) {
          window.clearInterval(timer);
          const i = list.indexOf(p);
          if (i >= 0) list.splice(i, 1);
          bus()?.emit({ type: 'projectileImpact', kind: 'boulder', pos: { x: p.pos.x, y: 0, z: p.pos.z }, radius: 2.5, ownerId: 0, hitId: -1 });
        }
      }, 1000 / 60);
    },
    blink(id: number, x: number, z: number): void {
      const w = world();
      if (w === null) return;
      const st = w.fighters[id].state;
      const from = { x: st.pos.x, y: st.pos.y, z: st.pos.z };
      st.pos.x = x;
      st.pos.z = z;
      bus()?.emit({ type: 'blink', fighterId: id, from, to: { x, y: st.pos.y, z } });
    },
    fizzle(): void {
      bus()?.emit({ type: 'ultimateFizzle', fighterId: 0, reason: 'noTarget' });
    },
    emit(ev: GameEvent): void {
      bus()?.emit(ev);
    },
    place(id: number, x: number, z: number): void {
      const w = world();
      if (w === null) return;
      w.fighters[id].state.pos.x = x;
      w.fighters[id].state.pos.z = z;
    },
  };
  (window as unknown as { __gkMatchTest?: typeof hooks }).__gkMatchTest = hooks;
}
