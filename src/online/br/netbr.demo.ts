/**
 * QA harness for the online Battle Royale screen (WP-N6), independent of the Online UI:
 *
 *   host tab:   http://localhost:5173/?demo=net-br&role=host&name=Hosty&animal=lion&signal=localhost:9000
 *   join tab:   http://localhost:5173/?demo=net-br&role=join&code=ABCDE&name=Ann&animal=gorilla&signal=localhost:9000
 *
 * A small panel shows the room (code, players) with READY (joiner) / START (host, needs >= 2 humans all ready) buttons; START
 * fills the roster with bots and mounts the real `createNetBattleRoyaleScreen`. `window.__netbr` exposes the room, the screen and
 * its driver for console inspection; `?autoready=1` readies the joiner on its own, `?autostart=1` starts as soon as allowed,
 * `?rafshim=1` keeps the match running in a background tab (see {@link installFrameShim}).
 */

import { registerDemo } from '../../core/demos';
import type { Screen } from '../../core/ScreenManager';
import type { AnimalId } from '../../core/types';
import { ANIMAL_IDS } from '../../config/animals';
import { AudioEngine } from '../../audio/AudioEngine';
import { OnlineRoom } from '../room';
import type { RoomState } from '../room';
import type { OnlineMatchResult } from '../matchTypes';
import { NetBattleRoyaleScreen } from './screen';

interface NetBrHandle {
  room: OnlineRoom | null;
  screen: NetBattleRoyaleScreen | null;
  exits: OnlineMatchResult[];
  state: RoomState | null;
}

function ensureCanvas(): HTMLCanvasElement {
  const existing = document.getElementById('gk-canvas');
  if (existing instanceof HTMLCanvasElement) return existing;
  const canvas = document.createElement('canvas');
  canvas.id = 'gk-canvas';
  document.body.insertBefore(canvas, document.body.firstChild);
  return canvas;
}

/**
 * QA: background tabs get no animation frames, so two tabs cannot both run a real-time match. `?rafshim=1` replaces
 * requestAnimationFrame with a ~60 Hz setTimeout pump (hidden tabs still get ~60 timer ticks/s in the browser pane).
 */
function installFrameShim(): () => void {
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  const cbs = new Map<number, FrameRequestCallback>();
  let id = 0;
  const FRAME = 1000 / 60;
  let nextAt = performance.now();
  let timer = 0;
  let lastPump = performance.now();
  const frames = { count: 0, maxGapMs: 0, gaps: [] as number[] };
  (window as unknown as { __netbrFrames?: typeof frames }).__netbrFrames = frames;
  const pump = (): void => {
    const now = performance.now();
    const gap = now - lastPump;
    lastPump = now;
    if (gap > frames.maxGapMs) frames.maxGapMs = gap;
    if (gap > 500 && frames.gaps.length < 20) frames.gaps.push(Math.round(gap));
    if (now >= nextAt - 1) {
      frames.count++;
      nextAt = now - nextAt > 100 ? now + FRAME : nextAt + FRAME;
      const list = [...cbs.values()];
      cbs.clear();
      for (const cb of list) cb(now);
    }
    timer = window.setTimeout(pump, Math.max(0, Math.min(FRAME, nextAt - performance.now())));
  };
  timer = window.setTimeout(pump, 0);
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    cbs.set(++id, cb);
    return id;
  };
  window.cancelAnimationFrame = (h: number): void => {
    cbs.delete(h);
  };
  return () => {
    window.clearTimeout(timer);
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCancel;
  };
}

registerDemo('net-br', async (root) => {
  const q = new URLSearchParams(window.location.search);
  const restoreRaf = q.get('rafshim') === '1' ? installFrameShim() : null;
  // QA: a software-GL first frame can stall the page for seconds; `?silence=60000` keeps the room's heartbeat timeout from firing.
  const silenceMs = Number(q.get('silence') ?? 0) || undefined;
  const role = q.get('role') === 'join' ? 'join' : 'host';
  const name = q.get('name') ?? (role === 'host' ? 'Hosty' : 'Joiner');
  const wanted = q.get('animal');
  const animal: AnimalId = wanted !== null && (ANIMAL_IDS as readonly string[]).includes(wanted) ? (wanted as AnimalId) : role === 'host' ? 'lion' : 'gorilla';
  const canvas = ensureCanvas();
  const audio = new AudioEngine();
  const handle: NetBrHandle = { room: null, screen: null, exits: [], state: null };
  (window as unknown as { __netbr?: NetBrHandle }).__netbr = handle;

  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:9999;pointer-events:auto;font:12px/1.4 ui-monospace,Consolas,monospace;color:#e8d8b0;background:rgba(20,17,13,.85);border:1px solid #6d6149;border-radius:4px;padding:6px 10px;max-width:340px;';
  const text = document.createElement('div');
  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
  panel.append(text, buttons);
  document.body.appendChild(panel);
  const say = (s: string): void => {
    text.textContent = s;
  };
  const btn = (label: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'font:inherit;padding:2px 8px;cursor:pointer;';
    b.addEventListener('click', fn);
    buttons.appendChild(b);
    return b;
  };

  say(role === 'host' ? 'Creating room…' : 'Joining…');
  let room: OnlineRoom;
  try {
    room =
      role === 'host'
        ? await OnlineRoom.host({ mode: 'battleRoyale', name, animal, silenceMs })
        : await OnlineRoom.join(q.get('code') ?? '', { name, animal, silenceMs });
  } catch (err) {
    say(`Room error: ${err instanceof Error ? err.message : String(err)}`);
    return () => panel.remove();
  }
  handle.room = room;

  let screen: Screen | null = null;
  const leaveMatch = (): void => {
    if (screen === null) return;
    screen.unmount();
    screen = null;
    handle.screen = null;
    room.backToRoom();
    panel.style.display = '';
  };

  const render = (s: RoomState): void => {
    handle.state = s;
    const humans = s.slots.filter((x) => x.kind === 'human');
    say(
      `${role.toUpperCase()}  code ${s.code}  phase ${s.phase}\n` +
        humans.map((h) => `${h.name} (${h.animal})${h.isHost ? ' HOST' : h.ready ? ' ready' : ''}${h.pingMs > 0 ? ` ${Math.round(h.pingMs)}ms` : ''}`).join(' | '),
    );
    text.style.whiteSpace = 'pre-wrap';
    if (q.get('autostart') === '1' && role === 'host' && s.canStart) room.startMatch();
  };
  room.on('state', render);
  render(room.state);

  room.on('start', (start, channel) => {
    panel.style.display = 'none';
    const s = new NetBattleRoyaleScreen({
      canvas,
      audio,
      start,
      channel,
      onExit: (r) => {
        handle.exits.push(r);
        console.info('[net-br] onExit', r);
        leaveMatch();
      },
    });
    screen = s;
    handle.screen = s;
    s.mount(root);
  });
  room.on('ended', (reason, message) => {
    say(`Room ended: ${reason} — ${message}`);
    panel.style.display = '';
    screen?.unmount();
    screen = null;
    handle.screen = null;
  });
  room.on('error', (e) => say(`Room error: ${e.message}`));

  if (role === 'host') btn('START', () => console.info('[net-br] startMatch blockers', room.startMatch()));
  else {
    btn('READY', () => room.setReady(true));
    if (q.get('autoready') === '1') room.setReady(true);
  }
  btn('LEAVE', () => room.leave());

  return () => {
    screen?.unmount();
    room.leave();
    panel.remove();
    audio.dispose();
    restoreRaf?.();
    delete (window as unknown as { __netbr?: NetBrHandle }).__netbr;
  };
});
