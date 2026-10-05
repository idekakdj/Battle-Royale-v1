import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetBrawlController, NET_BRAWL_BYE } from '../../src/brawl/net/NetBrawlController';
import { createNetBrawlScreen } from '../../src/brawl/net/screen';
import {
  WAIT_LEAVE_AFTER_S,
  WAIT_OVERLAY_DELAY_S,
  describeWait,
  endDialog,
  forfeitText,
  formatNetStats,
  formatPing,
  joinNames,
  pingTone,
} from '../../src/brawl/net/netHud';
import { buildNetResultsData } from '../../src/brawl/net/netResults';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { MSG } from '../../src/online/types';
import { ControllerRig, cancelRaf, fakeWin, installGlobals, kitOptions, makeKit, removeGlobals, winAdd, winRemove } from './netcontrollerRig';
import { makeStart } from './netHelpers';

beforeEach(installGlobals);
afterEach(removeGlobals);

describe('NetBrawlController — the Esc menu does not pause the sim', () => {
  it('Esc opens the menu, gameplay input is parked, the sim keeps stepping; Esc / Resume closes it', async () => {
    const rig = await ControllerRig.create({ n: 2, seed: 30 });
    rig.run(800);
    const a = rig.peer(0);
    const f0 = a.controller.session.frame;
    a.kit.inputHooks?.onPause();
    expect(a.controller.menuOpen).toBe(true);
    expect(a.kit.netHud.menu).toBe('main');
    expect(a.kit.input.setEnabled).toHaveBeenLastCalledWith(false);
    rig.run(500);
    expect(a.controller.session.frame).toBeGreaterThan(f0 + 20); // not paused
    const renders = a.kit.view.render.mock.calls.length;
    rig.run(100);
    expect(a.kit.view.render.mock.calls.length).toBeGreaterThan(renders);
    a.kit.inputHooks?.onPause(); // Esc again
    expect(a.controller.menuOpen).toBe(false);
    expect(a.kit.netHud.menu).toBeNull();
    expect(a.kit.input.setEnabled).toHaveBeenLastCalledWith(true);
    a.kit.inputHooks?.onPause();
    a.kit.netHud.hooks.onResume();
    expect(a.controller.menuOpen).toBe(false);
    expect(a.kit.input.setEnabled).toHaveBeenLastCalledWith(true);
  });

  it('Leave match: only the confirmed leave exits (peer-left), tells the others, and is not offered after the match ended', async () => {
    const rig = await ControllerRig.create({ n: 2, seed: 31 });
    rig.run(600);
    const a = rig.peer(0);
    a.kit.inputHooks?.onPause();
    expect(a.exits).toHaveLength(0); // the menu alone leaves nothing
    a.kit.netHud.hooks.onLeave();
    expect(a.exits).toEqual([{ reason: 'peer-left', message: 'You left the match.' }]);
    expect(a.controller.phase).toBe('closed');
    a.kit.netHud.hooks.onLeave();
    expect(a.exits).toHaveLength(1);
    a.controller.openMenu();
    expect(a.controller.menuOpen).toBe(false);
  });

  it('F3 toggles the debug boxes; F2 toggles the netstats block', async () => {
    const rig = await ControllerRig.create({ n: 2, seed: 32 });
    rig.run(500);
    const a = rig.peer(0);
    a.kit.inputHooks?.onToggleDebug();
    a.kit.inputHooks?.onToggleDebug();
    expect(a.kit.view.setDebugBoxes.mock.calls).toEqual([[true], [false]]);
    expect(a.kit.netHud.last?.detail).toBeNull();
    const onKey = winAdd.mock.calls.filter((c) => c[0] === 'keydown').map((c) => c[1] as (e: unknown) => void);
    expect(onKey.length).toBeGreaterThan(0);
    const prevent = vi.fn();
    onKey[0]({ code: 'F2', repeat: false, preventDefault: prevent });
    onKey[0]({ code: 'KeyA', repeat: false, preventDefault: prevent });
    expect(prevent).toHaveBeenCalledTimes(1);
    rig.run(100);
    expect(a.kit.netHud.last?.detail).toContain('rollbacks');
    a.controller.toggleDetail();
    rig.run(100);
    expect(a.kit.netHud.last?.detail).toBeNull();
  });
});

describe('NetBrawlController — names and the net HUD', () => {
  it('maps slots to the human names everywhere (HUD, pings, waiting, forfeits, results)', async () => {
    const rig = await ControllerRig.create({ n: 3, seed: 33, names: ['Zed', 'Amy', 'Bo'], stocks: 1, timeLimitS: 10 });
    const b = rig.peer(1);
    expect(b.controller.names).toEqual(['Zed', 'Amy', 'Bo']);
    expect(b.kit.hudNames).toEqual(['Zed', 'Amy', 'Bo']);
    expect(b.controller.config.roster.map((r) => r.isPlayer)).toEqual([false, true, false]); // only the local slot is a "player"
    rig.run(500);
    const pings = b.kit.netHud.last?.pings ?? [];
    expect(pings.map((p) => p.name)).toEqual(['Zed', 'Bo']); // opponents only, local excluded
    rig.run(240000, () => rig.live().every((p) => p.controller.phase === 'results'));
    const data = b.kit.resultsData;
    expect(data?.fighters.map((f) => f.name).sort()).toEqual(['Amy', 'Bo', 'Zed']);
    expect(data?.fighters.find((f) => f.isLocal)?.name).toBe('Amy');
    if (data?.winnerSlot !== undefined && data.winnerSlot >= 0) expect(data.winnerName).toBe(['Zed', 'Amy', 'Bo'][data.winnerSlot]);
  }, 60000);

  it('ping chips carry the measured round trip', async () => {
    const rig = await ControllerRig.create({ n: 2, seed: 34, cond: { latencyMs: 30, jitterMs: 0 } });
    rig.run(1500);
    const ms = rig.peer(0).kit.netHud.last?.pings[0].ms ?? 0;
    expect(ms).toBeGreaterThan(20); // the session measures on its own frame clock, so it reads a little low
    expect(ms).toBeLessThan(110);
  });
});

describe('NetBrawlController — lifecycle', () => {
  it('dispose releases everything once; unmount is the same; ticks and animation frames after it do nothing', async () => {
    const rig = await ControllerRig.create({ n: 2, seed: 35 });
    rig.run(500);
    const a = rig.peer(1); // the last one mounted owns the dev hook
    a.kit.inputHooks?.onPause();
    a.controller.dispose();
    a.controller.dispose();
    a.controller.unmount();
    expect(a.controller.isDisposed).toBe(true);
    expect(a.kit.view.dispose).toHaveBeenCalledTimes(1);
    expect(a.kit.input.dispose).toHaveBeenCalledTimes(1);
    expect(a.kit.hud.unmount).toHaveBeenCalledTimes(1);
    expect(a.kit.netHud.unmounted).toBe(1);
    expect(a.kit.audio.stop).toHaveBeenCalledTimes(1);
    expect(cancelRaf).toHaveBeenCalled();
    expect(winRemove.mock.calls.some((c) => c[0] === 'resize')).toBe(true);
    expect(winRemove.mock.calls.some((c) => c[0] === 'keydown')).toBe(true);
    expect(fakeWin.__gkNetBrawl).toBeUndefined();
    const renders = a.kit.view.render.mock.calls.length;
    a.controller.tick(1 / 60);
    expect(a.kit.view.render.mock.calls.length).toBe(renders);
    expect(a.exits).toHaveLength(0); // unmounting alone never reports an exit
    // the session no longer listens: the other peer's packets are ignored without errors
    rig.run(300);
  });

  it('exposes a dev hook while mounted', async () => {
    const rig = await ControllerRig.create({ n: 2, seed: 36 });
    const hook = fakeWin.__gkNetBrawl as { controller: unknown; session: unknown };
    expect(hook).toBeDefined();
    expect(hook.controller).toBe(rig.peer(1).controller); // the last one mounted
  });

  it('disposing before mount is harmless and a disposed controller never mounts', async () => {
    const rig = await ControllerRig.create({ n: 2, seed: 37, defer: [0, 1] });
    const kit = makeKit(0, 1);
    const exits: unknown[] = [];
    const c = new NetBrawlController({
      canvas: {} as HTMLCanvasElement,
      audio: {} as never,
      start: rig.makeStart(0),
      channel: rig.channels[0],
      onExit: (r) => exits.push(r),
      ...kitOptions(kit),
    });
    c.dispose();
    c.dispose();
    c.mount({} as HTMLElement);
    expect(c.isDisposed).toBe(true);
    expect(kit.hud.mount).not.toHaveBeenCalled();
    expect(exits).toHaveLength(0);
  });

  it('a view that cannot be created (no WebGL) ends the match with a friendly error instead of crashing, and tells the others', async () => {
    const rig = await ControllerRig.create({ n: 2, seed: 38, defer: [0] });
    rig.addPeer(1);
    const kit = makeKit(0, 1);
    const exits: Array<{ reason: string; message?: string }> = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = new NetBrawlController({
      canvas: {} as HTMLCanvasElement,
      audio: {} as never,
      start: rig.makeStart(0),
      channel: rig.channels[0],
      onExit: (r) => exits.push(r),
      ...kitOptions(kit),
      createView: () => {
        throw new Error('no webgl');
      },
    });
    c.mount({} as HTMLElement);
    spy.mockRestore();
    expect(exits).toHaveLength(1);
    expect(exits[0].reason).toBe('error');
    expect(exits[0].message).toContain('could not be started');
    expect(c.isDisposed).toBe(true);
    // the host said goodbye, so peer 1 does not wait for the stall timeout
    rig.run(300);
    expect(rig.peer(1).controller.phase).toBe('dialog');
  });

  it('the factory builds a controller whose session is already subscribed (no packet lost between start and mount)', async () => {
    const rig = await ControllerRig.create({ n: 2, seed: 39, defer: [0, 1] });
    const kit = makeKit(0, 1);
    const screen = createNetBrawlScreen({
      canvas: {} as HTMLCanvasElement,
      audio: {} as never,
      start: rig.makeStart(0),
      channel: rig.channels[0],
      onExit: () => undefined,
    });
    expect(screen).toBeInstanceOf(NetBrawlController);
    // packets that arrive before mount are already counted
    const other = rig.addPeer(1);
    rig.net.advance(5);
    other.controller.tick(1 / 60);
    other.controller.tick(1 / 60);
    rig.net.advance(5);
    expect((screen as NetBrawlController).session.stats.packetsReceived).toBeGreaterThan(0);
    (screen as NetBrawlController).dispose();
    expect(kit.hud.mount).not.toHaveBeenCalled();
  });

  it('uses an unassigned message kind for the goodbye and does not collide with the rollback kinds', () => {
    const used = new Set<number>(Object.values(MSG));
    expect(used.has(NET_BRAWL_BYE)).toBe(false);
    expect(NET_BRAWL_BYE).toBeGreaterThanOrEqual(0x10);
    expect(NET_BRAWL_BYE).toBeLessThan(0x20);
  });
});

describe('net HUD helpers', () => {
  it('ping tones and text', () => {
    expect(pingTone(0)).toBe('unknown');
    expect(pingTone(Number.NaN)).toBe('unknown');
    expect(pingTone(35)).toBe('good');
    expect(pingTone(90)).toBe('ok');
    expect(pingTone(200)).toBe('bad');
    expect(formatPing(0)).toBe('– ms');
    expect(formatPing(41.6)).toBe('42 ms');
  });

  it('joinNames', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['Ann'])).toBe('Ann');
    expect(joinNames(['Ann', 'Bob'])).toBe('Ann and Bob');
    expect(joinNames(['Ann', 'Bob', 'Cy'])).toBe('Ann, Bob and Cy');
  });

  it('describeWait: connecting, short stall (nothing), long stall (Leave + countdown), running (nothing)', () => {
    const base = { connecting: false, stalled: false, stalledS: 0, waiting: [] as string[], giveUpInS: null as number | null };
    expect(describeWait(base)).toBeNull();
    expect(describeWait({ ...base, stalled: true, stalledS: WAIT_OVERLAY_DELAY_S - 0.1, waiting: ['Bob'] })).toBeNull();
    const w = describeWait({ ...base, stalled: true, stalledS: 1, waiting: ['Bob'], giveUpInS: 11 });
    expect(w?.title).toBe('Waiting for Bob…');
    expect(w?.canLeave).toBe(false);
    expect(w?.sub).not.toMatch(/ends in/);
    const long = describeWait({ ...base, stalled: true, stalledS: WAIT_LEAVE_AFTER_S + 1, waiting: ['Bob', 'Cy'], giveUpInS: 7.2 });
    expect(long?.title).toBe('Waiting for Bob and Cy…');
    expect(long?.canLeave).toBe(true);
    expect(long?.sub).toContain('8 s');
    const c = describeWait({ ...base, connecting: true, stalledS: 0 });
    expect(c?.kind).toBe('connecting');
    expect(c?.title).toBe('Connecting…');
    expect(c?.sub).toContain('the other players');
  });

  it('endDialog: a friendly text for every early end', () => {
    const ctx = { hostName: 'Ann' };
    expect(endDialog('host-left', ctx).message).toContain('Ann');
    expect(endDialog('desync', ctx).title).toBe('Game out of sync — match ended');
    expect(endDialog('timeout', { ...ctx, waiting: ['Bob'] }).message).toContain('Bob');
    expect(endDialog('timeout', ctx).message).toContain('the other players');
    expect(endDialog('peer-left', { ...ctx, peerName: 'Cy' }).message).toContain('Cy');
    for (const r of ['host-left', 'peer-left', 'desync', 'timeout', 'version-mismatch', 'error'] as const) {
      const d = endDialog(r, ctx);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.button).toBe('Back to room');
    }
    expect(forfeitText('Bob')).toBe('Bob left — forfeited');
  });

  it('formatNetStats lists the rollback numbers', () => {
    const t = formatNetStats({
      rollbacks: 3,
      maxRollbackDepth: 5,
      resimulatedFrames: 12,
      stalls: 1,
      stalledFrames: 9,
      pingMs: 40,
      pingBySlot: [0, 40],
      remoteAdvantage: 0.5,
      inputDelay: 2,
      simFrame: 100,
      confirmedFrame: 97,
      timeScale: 1.01,
      packetsSent: 10,
      packetsReceived: 9,
      bytesSent: 2048,
      checksumsCompared: 2,
    });
    expect(t).toContain('rollbacks 3');
    expect(t).toContain('max depth 5');
    expect(t).toContain('(+3)');
    expect(t).toContain('2.0 KB');
  });
});

describe('buildNetResultsData', () => {
  it('orders winner first, then stocks / KOs / falls / damage, and uses the human names', () => {
    const start = makeStart(3, 1, 1);
    start.slots[0].name = 'Ann';
    start.slots[1].name = 'Bob';
    start.slots[2].name = 'Cy';
    const world = new BrawlWorld(
      { stage: 'brokenColosseum', roster: start.slots.map((s, i) => ({ animal: s.animal, isPlayer: i === 1 })), difficulty: 3, stocks: 3, timeLimitS: 0 },
      1,
    );
    const snap = world.snapshot();
    snap.fighters[0].stocks = 1;
    snap.fighters[1].stocks = 2;
    snap.fighters[2].stocks = 2;
    snap.fighters[2].kos = 3;
    snap.fighters[1].kos = 1;
    const data = buildNetResultsData({ start, config: world.config, snap, winnerId: 1, agreed: true, forfeited: (s) => s === 0 });
    expect(data.fighters.map((f) => f.name)).toEqual(['Bob', 'Cy', 'Ann']); // winner, then stocks desc / kos desc
    expect(data.fighters.map((f) => f.place)).toEqual([1, 2, 3]);
    expect(data.localWon).toBe(true);
    expect(data.localPlace).toBe(1);
    expect(data.winnerName).toBe('Bob');
    expect(data.fighters.find((f) => f.name === 'Ann')?.forfeited).toBe(true);
    expect(data.draw).toBe(false);
    const draw = buildNetResultsData({ start, config: world.config, snap, winnerId: -1, agreed: false });
    expect(draw.draw).toBe(true);
    expect(draw.winnerName).toBeNull();
    expect(draw.localWon).toBe(false);
    expect(draw.agreed).toBe(false);
  });
});
