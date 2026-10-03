import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrawlMatchController } from '../../src/brawl/BrawlMatchController';
import type { BrawlMatchControllerOptions } from '../../src/brawl/BrawlMatchController';
import { defaultBrawlSetup } from '../../src/brawl/ui/setup';
import { idleIntent } from '../../src/brawl/types';
import type {
  BrawlBotApi,
  BrawlEvent,
  BrawlInputApi,
  BrawlIntent,
  BrawlMatchConfig,
  BrawlSnapshot,
  BrawlViewApi,
  BrawlWorldApi,
} from '../../src/brawl/types';

const DT = 1 / 60;

class FakeWorld implements BrawlWorldApi {
  steps = 0;
  over = false;
  endAt = 0;
  queued: BrawlEvent[] = [];
  constructor(readonly config: BrawlMatchConfig) {}
  setIntent(): void {}
  step(): void {
    if (this.over) return;
    this.steps++;
    if (this.endAt > 0 && this.steps >= this.endAt) {
      this.over = true;
      this.queued.push({ type: 'matchEnd', winnerId: 0 });
    }
  }
  snapshot(): BrawlSnapshot {
    return {
      frame: this.steps,
      time: this.steps / 60,
      countdown: 0,
      timeLeft: null,
      fighters: [],
      platforms: [],
      hitboxes: [],
      matchOver: this.over,
      winnerId: this.over ? 0 : -1,
    };
  }
  drainEvents(): BrawlEvent[] {
    const out = this.queued;
    this.queued = [];
    return out;
  }
}

interface Rig {
  controller: BrawlMatchController;
  world: FakeWorld;
  view: BrawlViewApi & { render: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; setDebugBoxes: ReturnType<typeof vi.fn> };
  input: BrawlInputApi & { setEnabled: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  hud: { mount: ReturnType<typeof vi.fn>; unmount: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; onEvents: ReturnType<typeof vi.fn> };
  pause: { mount: ReturnType<typeof vi.fn>; unmount: ReturnType<typeof vi.fn> };
  audio: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; setPaused: ReturnType<typeof vi.fn>; onEvents: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  bots: number[];
  hooks: { input?: { onPause: () => void; onToggleDebug: () => void }; pause?: { onResume: () => void; onRestart: () => void; onQuitToLobby: () => void } };
  onMatchEnd: ReturnType<typeof vi.fn>;
  onQuitToLobby: ReturnType<typeof vi.fn>;
  onRestart: ReturnType<typeof vi.fn>;
}

function rig(over: Partial<BrawlMatchControllerOptions> = {}): Rig {
  const hooks: Rig['hooks'] = {};
  const bots: number[] = [];
  const state = { world: null as unknown as FakeWorld };
  const view = {
    render: vi.fn(),
    resize: vi.fn(),
    setDebugBoxes: vi.fn(),
    project: vi.fn(() => ({ x: 0, y: 0, onScreen: true })),
    dispose: vi.fn(),
  };
  const input = { poll: vi.fn((): BrawlIntent => idleIntent()), setEnabled: vi.fn(), dispose: vi.fn() };
  const hud = { mount: vi.fn(), unmount: vi.fn(), update: vi.fn(), onEvents: vi.fn() };
  const pause = { mount: vi.fn(), unmount: vi.fn() };
  const audio = { start: vi.fn(), stop: vi.fn(), setPaused: vi.fn(), onEvents: vi.fn(), update: vi.fn() };
  const onMatchEnd = vi.fn();
  const onQuitToLobby = vi.fn();
  const onRestart = vi.fn();
  const controller = new BrawlMatchController({
    canvas: {} as HTMLCanvasElement,
    audio: {} as never,
    setup: { ...defaultBrawlSetup('lion'), opponents: 3 },
    seed: 1234,
    onMatchEnd,
    onQuitToLobby,
    onRestart,
    createWorld: (config) => (state.world = new FakeWorld(config)),
    createView: () => view as unknown as BrawlViewApi,
    createBot: (id): BrawlBotApi => {
      bots.push(id);
      return { update: () => idleIntent() };
    },
    createInput: (h) => {
      hooks.input = h;
      return input;
    },
    createHud: () => hud,
    createPause: (h) => {
      hooks.pause = h;
      return pause;
    },
    createAudio: () => audio,
    ...over,
  });
  controller.mount({} as HTMLElement);
  return {
    controller,
    world: state.world,
    view: view as unknown as Rig['view'],
    input: input as unknown as Rig['input'],
    hud,
    pause,
    audio,
    bots,
    hooks,
    onMatchEnd,
    onQuitToLobby,
    onRestart,
  };
}

let rafCb: ((t: number) => void) | null = null;
const cancelRaf = vi.fn();
const winAdd = vi.fn();
const winRemove = vi.fn();
const docAdd = vi.fn();
const docRemove = vi.fn();
const fakeDoc = { addEventListener: docAdd, removeEventListener: docRemove, hidden: false };
const fakeWin: Record<string, unknown> = { addEventListener: winAdd, removeEventListener: winRemove, location: { search: '' } };

beforeEach(() => {
  rafCb = null;
  fakeDoc.hidden = false;
  delete fakeWin.__gkBrawl;
  vi.stubGlobal('window', fakeWin);
  vi.stubGlobal('document', fakeDoc);
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    rafCb = cb;
    return 42;
  });
  vi.stubGlobal('cancelAnimationFrame', cancelRaf);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('BrawlMatchController', () => {
  it('mount: one world, one view, one bot per non-player slot, HUD + audio started, first frame drawn', () => {
    const r = rig();
    expect(r.controller.config.roster).toHaveLength(4);
    expect(r.controller.config.roster[0].isPlayer).toBe(true);
    expect(r.bots).toEqual([1, 2, 3]);
    expect(r.hud.mount).toHaveBeenCalledTimes(1);
    expect(r.audio.start).toHaveBeenCalledTimes(1);
    expect(r.view.render).toHaveBeenCalledTimes(1);
    expect(rafCb).not.toBeNull();
    // the dev hook exposes the world / view / controller
    const hook = fakeWin.__gkBrawl as { world: unknown; view: unknown; controller: unknown };
    expect(hook.controller).toBe(r.controller);
    expect(hook.world).toBe(r.world);
    expect(hook.view).toBe(r.view);
  });

  it('the rAF loop steps the sim at 60 Hz and syncs the HUD / audio each frame', () => {
    const r = rig();
    // first rAF timestamp after mount: performance.now() is the baseline, so feed deltas explicitly through tick()
    for (let i = 0; i < 30; i++) r.controller.tick(DT);
    expect(r.world.steps).toBe(30);
    expect(r.hud.update).toHaveBeenCalled();
    expect(r.audio.update).toHaveBeenCalled();
    expect(r.hud.update.mock.calls.length).toBeGreaterThanOrEqual(30);
    // the rAF callback re-arms itself
    const before = rafCb;
    rafCb?.(performance.now() + 16);
    expect(rafCb).not.toBeNull();
    expect(before).not.toBeNull();
  });

  it('pause: the sim stops, the view keeps rendering, input is disabled, the menu mounts; resume undoes it', () => {
    const r = rig();
    for (let i = 0; i < 5; i++) r.controller.tick(DT);
    r.hooks.input?.onPause();
    expect(r.controller.isPaused).toBe(true);
    expect(r.pause.mount).toHaveBeenCalledTimes(1);
    expect(r.input.setEnabled).toHaveBeenLastCalledWith(false);
    expect(r.audio.setPaused).toHaveBeenLastCalledWith(true);
    const steps = r.world.steps;
    const renders = r.view.render.mock.calls.length;
    for (let i = 0; i < 30; i++) r.controller.tick(DT);
    expect(r.world.steps).toBe(steps);
    expect(r.view.render.mock.calls.length).toBe(renders + 30);
    r.hooks.input?.onPause(); // Esc again resumes
    expect(r.controller.isPaused).toBe(false);
    expect(r.pause.unmount).toHaveBeenCalledTimes(1);
    expect(r.input.setEnabled).toHaveBeenLastCalledWith(true);
    r.controller.tick(DT);
    expect(r.world.steps).toBe(steps + 1);
  });

  it('pause menu buttons: resume / restart / quit', () => {
    const r = rig();
    r.controller.requestPause();
    r.hooks.pause?.onRestart();
    expect(r.onRestart).toHaveBeenCalledTimes(1);
    r.hooks.pause?.onQuitToLobby();
    expect(r.onQuitToLobby).toHaveBeenCalledTimes(1);
    r.hooks.pause?.onResume();
    expect(r.controller.isPaused).toBe(false);
  });

  it('a hidden tab pauses; F3 toggles the debug boxes', () => {
    const r = rig();
    const onVisibility = docAdd.mock.calls.find((c) => c[0] === 'visibilitychange')?.[1] as () => void;
    expect(typeof onVisibility).toBe('function');
    fakeDoc.hidden = true;
    onVisibility();
    expect(r.controller.isPaused).toBe(true);
    r.hooks.input?.onToggleDebug();
    r.hooks.input?.onToggleDebug();
    expect(r.view.setDebugBoxes.mock.calls).toEqual([[true], [false]]);
  });

  it('match end: input off, no pausing once decided, onMatchEnd fires exactly once after the celebration', () => {
    const r = rig();
    r.world.endAt = 5;
    for (let i = 0; i < 5; i++) r.controller.tick(DT);
    expect(r.input.setEnabled).toHaveBeenCalledWith(false);
    r.controller.requestPause();
    expect(r.controller.isPaused).toBe(false);
    expect(r.onMatchEnd).not.toHaveBeenCalled();
    for (let i = 0; i < 60 * 4; i++) r.controller.tick(DT);
    expect(r.onMatchEnd).toHaveBeenCalledTimes(1);
    const results = r.onMatchEnd.mock.calls[0][0];
    expect(results.winnerId).toBe(0);
    expect(results.setup.animal).toBe('lion');
    for (let i = 0; i < 120; i++) r.controller.tick(DT);
    expect(r.onMatchEnd).toHaveBeenCalledTimes(1);
  });

  it('dispose releases everything once (idempotent); unmount is the same; ticks after it do nothing', () => {
    const r = rig();
    r.controller.requestPause();
    r.controller.dispose();
    r.controller.dispose();
    r.controller.unmount();
    expect(r.controller.isDisposed).toBe(true);
    expect(r.view.dispose).toHaveBeenCalledTimes(1);
    expect(r.input.dispose).toHaveBeenCalledTimes(1);
    expect(r.hud.unmount).toHaveBeenCalledTimes(1);
    expect(r.pause.unmount).toHaveBeenCalledTimes(1);
    expect(r.audio.stop).toHaveBeenCalledTimes(1);
    expect(cancelRaf).toHaveBeenCalledWith(42);
    expect(winRemove.mock.calls.some((c) => c[0] === 'resize')).toBe(true);
    expect(docRemove.mock.calls.some((c) => c[0] === 'visibilitychange')).toBe(true);
    expect(fakeWin.__gkBrawl).toBeUndefined();
    const renders = r.view.render.mock.calls.length;
    r.controller.tick(DT);
    rafCb?.(performance.now() + 16);
    expect(r.view.render.mock.calls.length).toBe(renders);
  });

  it('disposing before mount is harmless', () => {
    const c = new BrawlMatchController({
      canvas: {} as HTMLCanvasElement,
      audio: {} as never,
      setup: defaultBrawlSetup(),
      seed: 1,
      onMatchEnd: () => {},
      onQuitToLobby: () => {},
      onRestart: () => {},
    });
    c.dispose();
    c.dispose();
    c.mount({} as HTMLElement); // a disposed controller never mounts
    expect(c.isDisposed).toBe(true);
  });
});
