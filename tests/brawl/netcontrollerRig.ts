/**
 * Shared rig for the `NetBrawlController` tests: fake view / HUD / audio / net HUD / input / results (no DOM, no WebGL),
 * N controllers over the manual-clock `LoopbackNetwork`, and a driver that ticks every controller at ~60 Hz while the
 * network clock advances 1 ms at a time.
 */

import { vi } from 'vitest';
import { LoopbackNetwork } from '../../src/online/transport/loopback';
import type { NetConditions } from '../../src/online/transport/loopback';
import { LinkChannel } from '../../src/online/channel';
import type { Link, OnlineStart, Transport } from '../../src/online/types';
import type { OnlineMatchResult } from '../../src/online/matchTypes';
import { NetBrawlController } from '../../src/brawl/net/NetBrawlController';
import type { NetBrawlControllerOptions, NetSessionOptions } from '../../src/brawl/net/NetBrawlController';
import type { MenuView, NetDialog, NetHudHooks, NetHudState } from '../../src/brawl/net/netHud';
import type { NetResultsData } from '../../src/brawl/net/netResults';
import type { BrawlEvent, BrawlInputApi, BrawlIntent, BrawlViewApi } from '../../src/brawl/types';
import { makeStart, scriptIntent } from './netHelpers';

export class FakeNetHud {
  mounted = 0;
  unmounted = 0;
  states: NetHudState[] = [];
  forfeits: string[] = [];
  dialogs: NetDialog[] = [];
  menu: MenuView | null = null;
  menuOpens: MenuView[] = [];
  menuCloses = 0;
  hooks!: NetHudHooks;

  mount(): void {
    this.mounted++;
  }
  unmount(): void {
    this.unmounted++;
  }
  update(s: NetHudState): void {
    this.states.push(s);
    if (this.states.length > 400) this.states.splice(0, 200);
  }
  showForfeit(text: string): void {
    this.forfeits.push(text);
  }
  openMenu(view: MenuView = 'main'): void {
    this.menu = view;
    this.menuOpens.push(view);
  }
  closeMenu(): void {
    this.menu = null;
    this.menuCloses++;
  }
  showDialog(d: NetDialog): void {
    this.dialogs.push(d);
  }
  get last(): NetHudState | undefined {
    return this.states[this.states.length - 1];
  }
}

export interface Kit {
  view: { render: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; setDebugBoxes: ReturnType<typeof vi.fn>; project: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  input: { poll: ReturnType<typeof vi.fn>; setEnabled: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  inputHooks?: { onPause: () => void; onToggleDebug: () => void };
  hud: { mount: ReturnType<typeof vi.fn>; unmount: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; onEvents: ReturnType<typeof vi.fn> };
  hudNames?: readonly string[];
  audio: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; setPaused: ReturnType<typeof vi.fn>; onEvents: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  netHud: FakeNetHud;
  results: { mount: ReturnType<typeof vi.fn>; unmount: ReturnType<typeof vi.fn> };
  resultsData?: NetResultsData;
  resultsHooks?: { onBack: () => void };
  events: BrawlEvent[];
  polls: number;
}

export function makeKit(slot: number, seed: number, script?: (slot: number, frame: number) => BrawlIntent): Kit {
  const sc = script ?? ((s, f) => scriptIntent(seed, s, f));
  const kit: Kit = {
    view: { render: vi.fn(), resize: vi.fn(), setDebugBoxes: vi.fn(), project: vi.fn(() => ({ x: 0, y: 0, onScreen: true })), dispose: vi.fn() },
    input: { poll: vi.fn(), setEnabled: vi.fn(), dispose: vi.fn() },
    hud: { mount: vi.fn(), unmount: vi.fn(), update: vi.fn(), onEvents: vi.fn() },
    audio: { start: vi.fn(), stop: vi.fn(), setPaused: vi.fn(), onEvents: vi.fn(), update: vi.fn() },
    netHud: new FakeNetHud(),
    results: { mount: vi.fn(), unmount: vi.fn() },
    events: [],
    polls: 0,
  };
  kit.input.poll.mockImplementation(() => sc(slot, kit.polls++));
  kit.view.render.mockImplementation((_p: unknown, _c: unknown, _a: number, ev: readonly BrawlEvent[]) => {
    for (const e of ev) kit.events.push(e);
  });
  return kit;
}

export function kitOptions(kit: Kit): Pick<NetBrawlControllerOptions, 'createView' | 'createInput' | 'createHud' | 'createAudio' | 'createNetHud' | 'createResults'> {
  return {
    createView: () => kit.view as unknown as BrawlViewApi,
    createInput: (h) => {
      kit.inputHooks = h;
      return kit.input as unknown as BrawlInputApi;
    },
    createHud: (_c, _p, names) => {
      kit.hudNames = names;
      return kit.hud;
    },
    createAudio: () => kit.audio,
    createNetHud: (hooks) => {
      kit.netHud.hooks = hooks;
      return kit.netHud;
    },
    createResults: (data, hooks) => {
      kit.resultsData = data;
      kit.resultsHooks = hooks;
      return kit.results;
    },
  };
}

// ── global stubs (window / document / rAF) ───────────────────────────────────

export const winAdd = vi.fn();
export const winRemove = vi.fn();
export const cancelRaf = vi.fn();
export const fakeWin: Record<string, unknown> = { addEventListener: winAdd, removeEventListener: winRemove, location: { search: '' } };
export const fakeDoc = { addEventListener: vi.fn(), removeEventListener: vi.fn(), hidden: false };
let rafSeq = 0;

export function installGlobals(): void {
  rafSeq = 0;
  delete fakeWin.__gkNetBrawl;
  vi.stubGlobal('window', fakeWin);
  vi.stubGlobal('document', fakeDoc);
  vi.stubGlobal('requestAnimationFrame', () => ++rafSeq);
  vi.stubGlobal('cancelAnimationFrame', cancelRaf);
}

export function removeGlobals(): void {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
}

// ── the mesh ─────────────────────────────────────────────────────────────────

export interface RigPeer {
  slot: number;
  id: string;
  transport: Transport;
  channel: LinkChannel;
  controller: NetBrawlController;
  kit: Kit;
  exits: OnlineMatchResult[];
  start: OnlineStart;
  nextAt: number;
  lastAt: number;
  paused: boolean;
}

export interface RigOptions {
  n: number;
  cond?: Partial<NetConditions>;
  netSeed?: number;
  seed?: number;
  stocks?: number;
  timeLimitS?: number;
  celebrationS?: number;
  /** Per-slot session tuning (stall timeout, custom world, …). */
  session?: (slot: number) => NetSessionOptions | undefined;
  /** Names per slot (default P0, P1, …). */
  names?: string[];
  /** Skip creating the controllers of these slots (they can be added later with `addPeer`). */
  defer?: number[];
  script?: (slot: number, frame: number) => BrawlIntent;
}

export class ControllerRig {
  readonly net: LoopbackNetwork;
  readonly peers: Array<RigPeer | null> = [];
  readonly transports: Transport[] = [];
  readonly channels: LinkChannel[] = [];
  readonly seed: number;

  private constructor(readonly opts: RigOptions) {
    this.net = new LoopbackNetwork(opts.cond ?? {}, opts.netSeed ?? 7);
    this.seed = opts.seed ?? 4321;
  }

  static async create(opts: RigOptions): Promise<ControllerRig> {
    const rig = new ControllerRig(opts);
    const n = opts.n;
    for (let i = 0; i < n; i++) {
      const t = rig.net.createTransport();
      const id = await t.open(`p${i}`);
      const ch = new LinkChannel(id);
      t.setHandlers({
        onLink: (l: Link) => ch.addLink(l),
        onData: (l, c, d) => ch.handleData(l, c, d),
        onClose: (l, r) => ch.handleClose(l, r),
      });
      rig.transports.push(t);
      rig.channels.push(ch);
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const link = await rig.transports[i].connect(`p${j}`);
        rig.channels[i].addLink(link);
      }
    }
    rig.net.advance(Math.max(1, (opts.cond?.latencyMs ?? 0) + (opts.cond?.jitterMs ?? 0) + 1));
    for (let i = 0; i < n; i++) rig.peers.push(null);
    for (let i = 0; i < n; i++) if (!(opts.defer ?? []).includes(i)) rig.addPeer(i);
    return rig;
  }

  makeStart(slot: number): OnlineStart {
    const o = this.opts;
    const s = makeStart(o.n, slot, this.seed, 'brokenColosseum', { stocks: o.stocks ?? 1, timeLimitS: o.timeLimitS ?? 12 });
    if (o.names !== undefined) s.slots.forEach((x, i) => (x.name = o.names?.[i] ?? x.name));
    return s;
  }

  /** Create + mount the controller of `slot`. */
  addPeer(slot: number): RigPeer {
    const kit = makeKit(slot, this.seed, this.opts.script);
    const exits: OnlineMatchResult[] = [];
    const start = this.makeStart(slot);
    const controller = new NetBrawlController({
      canvas: {} as HTMLCanvasElement,
      audio: {} as never,
      start,
      channel: this.channels[slot],
      onExit: (r) => exits.push(r),
      celebrationS: this.opts.celebrationS ?? 0.5,
      sessionOptions: this.opts.session?.(slot),
      ...kitOptions(kit),
    });
    controller.mount({} as HTMLElement);
    const peer: RigPeer = { slot, id: `p${slot}`, transport: this.transports[slot], channel: this.channels[slot], controller, kit, exits, start, nextAt: this.net.now, lastAt: this.net.now, paused: false };
    this.peers[slot] = peer;
    return peer;
  }

  peer(slot: number): RigPeer {
    const p = this.peers[slot];
    if (p === null || p === undefined) throw new Error(`peer ${slot} not created`);
    return p;
  }

  live(): RigPeer[] {
    return this.peers.filter((p): p is RigPeer => p !== null);
  }

  /** Advance simulated real time by `ms` (1 ms resolution): the network clock and every controller's tick. */
  run(ms: number, until?: () => boolean): void {
    const period = 1000 / 60;
    for (let t = 0; t < ms; t++) {
      this.net.advance(1);
      for (const p of this.live()) {
        if (p.paused || p.controller.isDisposed) continue;
        if (this.net.now >= p.nextAt) {
          const dt = Math.max(0, (this.net.now - p.lastAt) / 1000);
          p.lastAt = this.net.now;
          p.nextAt += period;
          if (p.nextAt < this.net.now) p.nextAt = this.net.now + period;
          p.controller.tick(dt);
        }
      }
      if (until !== undefined && until()) return;
    }
  }

  /** Remove a peer from the network the way the room does when somebody leaves (links close, remotes see `peer-left`). */
  disconnect(slot: number): void {
    this.channels[slot].close();
    this.transports[slot].dispose();
  }
}
