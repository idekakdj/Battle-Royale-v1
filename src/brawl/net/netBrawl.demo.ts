/**
 * `?demo=net-cl` — QA harness for the Champions League ONLINE match (v1.5, WP-N5). Creates / joins a real
 * `OnlineRoom` (Champions League mode) and mounts `createNetBrawlScreen` when the host starts the match — no lobby UI needed.
 *
 *   Two tabs against `node scripts/dev-signal.mjs` (port 9000):
 *     host:  http://localhost:5601/?demo=net-cl&role=host&signal=localhost:9000&name=Ann&animal=lion&auto=2
 *     join:  http://localhost:5601/?demo=net-cl&role=join&code=ABCDE&signal=localhost:9000&name=Bob&animal=gorilla
 *   (the host's panel shows the code and the exact join URL; `auto=N` starts the match when N humans are in the room)
 *
 *   role    host | join                  code    room code to join          name / animal    your name and fighter
 *   stage   brokenColosseum | skyAqueduct  stocks  1..5 (host)               time   seconds, 0 = none (host)
 *   auto    host: start when this many humans are ready      script  1 = the local input is a scripted random player
 *   netsim  latency:60,jitter:20,loss:0.05 (see src/online/transport/conditioned.ts)     qa=1  expose window.__gkNetBrawl
 *
 * Automation: `window.__netBrawlDemo = { room, controller, tick(dt), status(), start(), leave(), back(), exits }`.
 * A hidden tab does not get animation frames, so the demo drives `controller.tick` from a timer while `document.hidden`.
 */

import { registerDemo } from '../../core/demos';
import { ScreenManager } from '../../core/ScreenManager';
import { AudioEngine } from '../../audio/AudioEngine';
import { ANIMAL_IDS } from '../../config/animals';
import type { AnimalId } from '../../core/types';
import { OnlineRoom } from '../../online/room';
import type { RoomState } from '../../online/room';
import type { OnlineMatchResult } from '../../online/matchTypes';
import { BrawlInput } from '../ui/BrawlInput';
import { STAGE_IDS, idleIntent } from '../types';
import type { BrawlInputApi, BrawlIntent, StageId } from '../types';
import { NetBrawlController } from './NetBrawlController';

function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** A pure scripted "player" (runs about, jumps, attacks, dodges) — one `poll()` per fresh sim frame. */
function scripted(seed: number, n: number): BrawlIntent {
  const seg = mix(seed, n >> 3);
  const dirs = [-1, -1, -0.5, 0, 0.5, 1, 1, 0.75];
  const r = mix(seed ^ 0x1234, n);
  const jump = (r & 31) === 0;
  return {
    moveX: dirs[seg & 7],
    moveY: ((seg >>> 3) & 15) === 0 ? -1 : 0,
    jump,
    jumpHeld: jump || (mix(seed ^ 0x77, n >> 2) & 3) === 0,
    light: ((r >>> 5) & 15) === 0,
    heavy: ((r >>> 9) & 31) === 0,
    dodge: ((r >>> 14) & 63) === 0,
  };
}

interface DemoApi {
  room: OnlineRoom | null;
  controller: NetBrawlController | null;
  /** Every `onExit` result of the matches played in this page. */
  exits: OnlineMatchResult[];
  tick(dt: number): void;
  status(): Record<string, unknown>;
  start(): void;
  leave(): void;
  back(): void;
}

registerDemo('net-cl', async (root) => {
  const params = new URLSearchParams(window.location.search);
  const role = params.get('role') === 'join' ? 'join' : 'host';
  const name = params.get('name') ?? (role === 'host' ? 'Host' : 'Guest');
  const animalParam = params.get('animal') as AnimalId | null;
  const animal: AnimalId = animalParam !== null && (ANIMAL_IDS as readonly string[]).includes(animalParam) ? animalParam : role === 'host' ? 'lion' : 'gorilla';
  const stageParam = params.get('stage') as StageId | null;
  const stage: StageId = stageParam !== null && STAGE_IDS.includes(stageParam) ? stageParam : 'brokenColosseum';
  const stocks = Math.max(1, Math.min(5, Number(params.get('stocks') ?? 3) || 3));
  const timeLimitS = Math.max(0, Number(params.get('time') ?? 300) || 0);
  const auto = Number(params.get('auto') ?? 0) || 0;
  const useScript = params.get('script') === '1';

  const canvas = document.getElementById('gk-canvas') as HTMLCanvasElement;
  const audio = new AudioEngine();
  const screens = new ScreenManager(root);
  const api: DemoApi = {
    room: null,
    controller: null,
    exits: [],
    tick: (dt) => api.controller?.tick(dt),
    status: () => ({}),
    start: () => void 0,
    leave: () => void 0,
    back: () => void 0,
  };
  (window as unknown as { __netBrawlDemo: DemoApi }).__netBrawlDemo = api;

  // ── status panel ───────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;left:10px;bottom:10px;z-index:60;max-width:430px;padding:10px 14px;border:1px solid #6d6149;border-radius:8px;background:rgba(20,17,13,.88);color:#ece3d0;font:12px/1.5 ui-monospace,Consolas,monospace;pointer-events:auto;';
  const title = document.createElement('div');
  title.style.cssText = 'color:#f0c368;font-weight:600;margin-bottom:4px;';
  title.textContent = `net-cl demo — ${role} "${name}"`;
  const info = document.createElement('div');
  info.style.whiteSpace = 'pre-wrap';
  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
  const mk = (label: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'padding:3px 10px;border:1px solid #9a8c6e;border-radius:4px;background:#3a3225;color:#ece3d0;cursor:pointer;';
    b.addEventListener('click', fn);
    return b;
  };
  panel.append(title, info, btns);
  document.body.appendChild(panel);

  let room: OnlineRoom | null = null;
  let controller: NetBrawlController | null = null;
  let note = 'connecting…';
  let autoStarted = false;
  let lastTickAt = performance.now();

  const render = (): void => {
    const st: RoomState | null = room?.state ?? null;
    const lines: string[] = [];
    if (st !== null) {
      lines.push(`room ${st.code}   phase ${st.phase}   mode ${st.mode}`);
      for (const s of st.slots) lines.push(`  ${s.isHost ? '★' : ' '} ${s.name} (${s.animal})${s.ready ? ' ready' : ''}${s.isLocal ? '  ← you' : ''}${s.pingMs > 0 ? `  ${Math.round(s.pingMs)} ms` : ''}`);
      if (role === 'host') {
        const u = new URL(window.location.href);
        const j = new URLSearchParams(u.search);
        j.set('role', 'join');
        j.set('code', st.code);
        j.delete('auto');
        j.delete('name');
        j.delete('animal');
        lines.push(`join: ${u.origin}${u.pathname}?${j.toString()}&name=Guest&animal=gorilla`);
      }
    }
    lines.push(note);
    info.textContent = lines.join('\n');
    panel.style.display = controller !== null && !controller.isDisposed ? 'none' : 'block';
    if (role === 'host' && st !== null && st.phase === 'lobby' && auto > 0 && !autoStarted && st.slots.filter((s) => s.kind === 'human').length >= auto && st.canStart) {
      autoStarted = true;
      void Promise.resolve().then(() => room?.startMatch());
    }
  };

  const openLobbyAgain = (): void => {
    screens.unmount();
    controller = null;
    api.controller = null;
    autoStarted = false;
    if (role === 'join') room?.setReady(true);
    render();
  };

  const begin = (start: import('../../online/types').OnlineStart, channel: import('../../online/types').GameChannel): void => {
    const hooks = (h: { onPause: () => void; onToggleDebug: () => void }): BrawlInputApi => {
      const real = new BrawlInput({ mouseTarget: canvas, ...h });
      if (!useScript) return real;
      let n = 0;
      return {
        poll: () => (real.isEnabled ? scripted(0x5eed + start.localSlot * 977, n++) : idleIntent()),
        setEnabled: (e) => real.setEnabled(e),
        dispose: () => real.dispose(),
      };
    };
    const c = new NetBrawlController({
      canvas,
      audio,
      start,
      channel,
      createInput: (h) => hooks(h),
      onExit: (result) => {
        api.exits.push(result);
        note = result.reason === 'finished' ? 'match finished' : `match ended early: ${result.reason} — ${result.message ?? ''}`;
        room?.backToRoom();
        openLobbyAgain();
      },
    });
    const tick = c.tick.bind(c);
    c.tick = (dt: number): void => {
      lastTickAt = performance.now();
      tick(dt);
    };
    lastTickAt = performance.now();
    controller = c;
    api.controller = c;
    audio.stopMusic();
    screens.transition(c);
    render();
  };

  try {
    if (role === 'host') {
      room = await OnlineRoom.host({ name, animal, mode: 'championsLeague', settings: { cl: { stage, stocks, timeLimitS } } });
      note = auto > 0 ? `waiting for ${auto} humans, then the match starts automatically` : 'press Start when everybody is ready';
      btns.append(mk('Start', () => void room?.startMatch()));
    } else {
      const code = params.get('code') ?? '';
      room = await OnlineRoom.join(code, { name, animal });
      room.setReady(true);
      note = 'joined — waiting for the host to start';
    }
  } catch (err) {
    note = `failed: ${err instanceof Error ? err.message : String(err)}`;
    render();
    return;
  }

  api.room = room;
  room.on('state', render);
  room.on('start', (start, channel) => begin(start, channel));
  room.on('ended', (reason, message) => {
    note = `room ended: ${reason} — ${message}`;
    render();
  });
  room.on('error', (e) => {
    note = `room error: ${e.message}`;
    render();
  });

  api.start = (): void => void room?.startMatch();
  api.leave = (): void => controller?.leave();
  api.back = (): void => room?.backToRoom();
  api.status = (): Record<string, unknown> => {
    const c = controller;
    const s = c?.session;
    return {
      role,
      code: room?.state.code,
      phase: room?.state.phase,
      humans: room?.state.slots.length,
      controllerPhase: c?.phase ?? null,
      frame: s?.frame ?? null,
      confirmed: s?.confirmed ?? null,
      stalled: s?.stalled ?? null,
      ended: s?.ended ?? null,
      result: s?.result ?? null,
      desynced: s?.isDesynced ?? null,
      stats: s !== undefined ? { ...s.stats, pingBySlot: [...s.stats.pingBySlot] } : null,
      exits: api.exits,
      note,
    };
  };

  // A hidden (or occluded) pane gets no animation frames: whenever the controller has not ticked for a while, drive it
  // from a timer. A worker's timer is not throttled in background tabs, unlike `setInterval` on the page, and it is
  // self-paced (the next beat is sent only after the page answered) so slow frames can never build a backlog.
  const drive = (): void => {
    const c = controller;
    if (c === null || c.isDisposed) return;
    const now = performance.now();
    if (now - lastTickAt < 40) return;
    c.tick((now - lastTickAt) / 1000);
  };
  try {
    const url = URL.createObjectURL(new Blob(['onmessage=function(){setTimeout(function(){postMessage(0)},16)};postMessage(0)'], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = () => {
      drive();
      worker.postMessage(0);
    };
  } catch {
    window.setInterval(drive, 1000 / 60);
  }

  render();
});
