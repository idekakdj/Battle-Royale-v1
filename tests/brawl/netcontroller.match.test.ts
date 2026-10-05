import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NET_BRAWL_BYE } from '../../src/brawl/net/NetBrawlController';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { forfeitText } from '../../src/brawl/net/netHud';
import { ControllerRig, installGlobals, removeGlobals } from './netcontrollerRig';
import type { RigPeer } from './netcontrollerRig';

beforeEach(installGlobals);
afterEach(removeGlobals);

const allIn = (rig: ControllerRig, phase: string): boolean => rig.live().every((p) => p.controller.phase === phase);

describe('NetBrawlController — full online matches over the loopback network', () => {
  it.each([2, 3, 4])('%i peers play a match to an agreed result: same winner and standings everywhere, one onExit each', async (n) => {
    const rig = await ControllerRig.create({ n, stocks: 1, timeLimitS: 14, seed: 100 + n });
    rig.run(240000, () => allIn(rig, 'results'));
    expect(allIn(rig, 'results')).toBe(true);

    const first = rig.peer(0);
    const winner = first.kit.resultsData?.winnerSlot;
    expect(winner).toBeDefined();
    const sums = new Set<number>();
    for (const p of rig.live()) {
      const data = p.kit.resultsData;
      expect(data).toBeDefined();
      expect(data?.agreed).toBe(true);
      expect(data?.winnerSlot).toBe(winner);
      expect(data?.fighters).toHaveLength(n);
      // standings (without the per-machine "isLocal" flag) are identical on every peer
      const strip = (d: typeof data): unknown => d?.fighters.map((f) => ({ ...f, isLocal: false }));
      expect(strip(data)).toEqual(strip(first.kit.resultsData));
      expect(data?.fighters.filter((f) => f.isLocal)).toHaveLength(1);
      expect(data?.fighters.find((f) => f.isLocal)?.slot).toBe(p.slot);
      // names come from the room, not from the animals
      expect(data?.fighters.map((f) => f.name).sort()).toEqual(Array.from({ length: n }, (_, i) => `P${i}`));
      expect(data?.localWon).toBe(p.slot === winner && winner !== -1);
      const res = p.controller.session.result;
      expect(res?.reason).toBe('finished');
      expect(res?.agreed).toBe(true);
      sums.add(res?.checksum ?? -1);
      // the in-game layers are gone, the results screen is up, nothing exited yet
      expect(p.kit.view.dispose).toHaveBeenCalledTimes(1);
      expect(p.kit.hud.unmount).toHaveBeenCalledTimes(1);
      expect(p.kit.netHud.unmounted).toBe(1);
      expect(p.kit.audio.stop).toHaveBeenCalledTimes(1);
      expect(p.kit.input.dispose).toHaveBeenCalledTimes(1);
      expect(p.kit.results.mount).toHaveBeenCalledTimes(1);
      expect(p.exits).toHaveLength(0);
    }
    expect(sums.size).toBe(1);

    // "Back to room": exactly one onExit({ reason: 'finished' })
    for (const p of rig.live()) {
      p.kit.resultsHooks?.onBack();
      p.kit.resultsHooks?.onBack();
      expect(p.exits).toEqual([{ reason: 'finished' }]);
    }
  }, 120000);

  it('under latency, jitter and loss: rollbacks happen, no desync, still one agreed result', async () => {
    const rig = await ControllerRig.create({ n: 3, stocks: 1, timeLimitS: 12, seed: 55, cond: { latencyMs: 45, jitterMs: 25, loss: 0.05 }, netSeed: 9 });
    rig.run(300000, () => allIn(rig, 'results'));
    expect(allIn(rig, 'results')).toBe(true);
    const rollbacks = rig.live().reduce((a, p) => a + p.controller.session.stats.rollbacks, 0);
    expect(rollbacks).toBeGreaterThan(0);
    const res = rig.live().map((p) => p.controller.session.result);
    expect(new Set(res.map((r) => r?.checksum)).size).toBe(1);
    expect(new Set(res.map((r) => r?.winnerId)).size).toBe(1);
    for (const p of rig.live()) {
      expect(p.controller.session.isDesynced).toBe(false);
      expect(p.kit.netHud.dialogs).toHaveLength(0);
    }
  }, 120000);

  it('events reach the view, the HUD and the audio exactly once (the session de-duplicates rollbacks)', async () => {
    const rig = await ControllerRig.create({ n: 2, stocks: 1, timeLimitS: 8, seed: 21, cond: { latencyMs: 40, jitterMs: 20, loss: 0.03 }, netSeed: 3 });
    rig.run(240000, () => allIn(rig, 'results'));
    for (const p of rig.live()) {
      expect(p.kit.events.some((e) => e.type === 'hit' || e.type === 'moveStart')).toBe(true);
      expect(p.kit.events.filter((e) => e.type === 'matchEnd')).toHaveLength(1);
      expect(p.kit.hud.onEvents).toHaveBeenCalled();
      expect(p.kit.audio.onEvents).toHaveBeenCalled();
      expect(p.kit.audio.update).toHaveBeenCalled();
    }
  }, 120000);
});

describe('NetBrawlController — a peer leaving mid-match', () => {
  it('forfeit banner on the others, the match goes on to a result with the leaver marked', async () => {
    const rig = await ControllerRig.create({ n: 3, stocks: 2, timeLimitS: 14, seed: 77, names: ['Ann', 'Bob', 'Cy'] });
    rig.run(1800);
    const leaver = rig.peer(2);
    expect(leaver.controller.phase).toBe('playing');
    leaver.controller.leave();
    expect(leaver.exits).toEqual([{ reason: 'peer-left', message: 'You left the match.' }]);
    leaver.controller.leave(); // idempotent
    expect(leaver.exits).toHaveLength(1);
    // what the room layer does for a leaver: the links go away
    rig.disconnect(2);
    leaver.controller.dispose();

    const others = [rig.peer(0), rig.peer(1)];
    rig.run(3000, () => others.every((p) => p.kit.netHud.forfeits.length > 0));
    for (const p of others) {
      expect(p.kit.netHud.forfeits).toEqual([forfeitText('Cy')]);
      expect(p.controller.phase).toBe('playing');
      expect(p.kit.netHud.dialogs).toHaveLength(0);
    }
    const frame = others[0].controller.session.frame;
    rig.run(500);
    expect(others[0].controller.session.frame).toBeGreaterThan(frame); // still running
    const chip = others[0].kit.netHud.last?.pings.find((x) => x.name === 'Cy');
    expect(chip?.gone).toBe(true);

    rig.run(240000, () => others.every((p) => p.controller.phase === 'results'));
    for (const p of others) {
      expect(p.controller.phase).toBe('results');
      const cy = p.kit.resultsData?.fighters.find((f) => f.name === 'Cy');
      expect(cy?.forfeited).toBe(true);
      expect(p.kit.resultsData?.winnerSlot).not.toBe(2);
    }
    expect(others[0].kit.resultsData?.winnerSlot).toBe(others[1].kit.resultsData?.winnerSlot);
  }, 120000);

  it('the last opponent leaving ends the match with the remaining player as the winner', async () => {
    const rig = await ControllerRig.create({ n: 2, stocks: 3, timeLimitS: 0, seed: 5, names: ['Ann', 'Bob'] });
    rig.run(1500);
    const host = rig.peer(0);
    rig.peer(1).controller.leave();
    rig.disconnect(1);
    rig.run(20000, () => host.controller.phase === 'results');
    expect(host.controller.phase).toBe('results');
    expect(host.kit.resultsData?.winnerSlot).toBe(0);
    expect(host.kit.resultsData?.localWon).toBe(true);
    expect(host.kit.netHud.forfeits).toEqual([forfeitText('Bob')]);
  }, 60000);
});

describe('NetBrawlController — connecting and waiting', () => {
  it('shows "Connecting…" until every peer\'s first inputs arrived, then runs', async () => {
    const rig = await ControllerRig.create({ n: 2, seed: 8, defer: [1], names: ['Ann', 'Bob'] });
    const a = rig.peer(0);
    rig.run(300);
    const w = a.kit.netHud.last?.wait;
    expect(w?.kind).toBe('connecting');
    expect(w?.title).toBe('Connecting…');
    expect(w?.sub).toContain('Bob');
    rig.addPeer(1);
    rig.run(600);
    expect(a.kit.netHud.last?.wait).toBeNull();
    expect(a.controller.session.confirmed).toBeGreaterThan(0);
  });

  it('a stall shows "Waiting for <name>…" after a short delay, the Leave button later, and hides when the peer is back', async () => {
    const rig = await ControllerRig.create({ n: 3, seed: 9, names: ['Ann', 'Bob', 'Cy'] });
    rig.run(1500);
    const a = rig.peer(0);
    expect(a.kit.netHud.last?.wait).toBeNull();
    expect(a.kit.netHud.last?.sync).not.toBe('stalled');

    rig.peer(2).paused = true;
    rig.run(300);
    expect(a.kit.netHud.last?.wait).toBeNull(); // a short hiccup is not worth an overlay
    rig.run(1000);
    let w = a.kit.netHud.last?.wait;
    expect(a.controller.session.stalled).toBe(true);
    expect(w?.kind).toBe('stalled');
    expect(w?.title).toBe('Waiting for Cy…');
    expect(w?.canLeave).toBe(false);
    expect(a.kit.netHud.last?.sync).toBe('stalled');

    rig.run(2800);
    w = a.kit.netHud.last?.wait;
    expect(w?.canLeave).toBe(true);
    expect(w?.sub).toMatch(/ends in \d+ s/);

    // the Leave button of the panel opens the menu on the confirmation (and parks the input)
    a.kit.netHud.hooks.onRequestLeave();
    expect(a.kit.netHud.menu).toBe('confirm');
    expect(a.controller.menuOpen).toBe(true);
    a.kit.netHud.hooks.onResume();
    expect(a.controller.menuOpen).toBe(false);

    rig.peer(2).paused = false;
    rig.run(1500);
    expect(a.controller.session.stalled).toBe(false);
    expect(a.kit.netHud.last?.wait).toBeNull();
  });

  it('two stalled peers are named together', async () => {
    const rig = await ControllerRig.create({ n: 3, seed: 10, names: ['Ann', 'Bob', 'Cy'] });
    rig.run(1200);
    rig.peer(1).paused = true;
    rig.peer(2).paused = true;
    rig.run(1500);
    expect(rig.peer(0).kit.netHud.last?.wait?.title).toBe('Waiting for Bob and Cy…');
  });

  it('the stall timeout ends the match: dialog "Connection lost" naming who stopped responding, then onExit(timeout)', async () => {
    const rig = await ControllerRig.create({ n: 2, seed: 11, names: ['Ann', 'Bob'], session: () => ({ stallTimeoutMs: 1500 }) });
    rig.run(1200);
    const a = rig.peer(0);
    rig.peer(1).paused = true;
    rig.run(5000, () => a.controller.phase === 'dialog');
    expect(a.controller.phase).toBe('dialog');
    const d = a.kit.netHud.dialogs[0];
    expect(d.title).toBe('Connection lost');
    expect(d.message).toContain('Bob');
    expect(a.exits).toHaveLength(0);
    expect(a.kit.audio.stop).toHaveBeenCalledTimes(1);
    a.kit.netHud.hooks.onDialogClose();
    a.kit.netHud.hooks.onDialogClose();
    expect(a.exits).toEqual([{ reason: 'timeout', message: d.message }]);
  });
});

describe('NetBrawlController — desync', () => {
  class BadWorld extends BrawlWorld {
    override step(): void {
      super.step();
      if (this.frame === 45) (this as unknown as { fighters: Array<{ percent: number }> }).fighters[0].percent += 3;
    }
  }

  it('a checksum mismatch ends the match with the "Game out of sync" dialog on both machines, then onExit(desync)', async () => {
    const rig = await ControllerRig.create({
      n: 2,
      seed: 12,
      names: ['Ann', 'Bob'],
      session: (slot) => (slot === 1 ? { createWorld: (c, s) => new BadWorld(c, s) } : undefined),
    });
    rig.run(30000, () => allIn(rig, 'dialog'));
    expect(allIn(rig, 'dialog')).toBe(true);
    for (const p of rig.live()) {
      expect(p.kit.netHud.dialogs).toHaveLength(1);
      expect(p.kit.netHud.dialogs[0].title).toBe('Game out of sync — match ended');
      expect(p.exits).toHaveLength(0);
      // the match is over for this machine: no more sim frames
      const f = p.controller.session.frame;
      rig.run(300);
      expect(p.controller.session.frame).toBe(f);
      p.kit.netHud.hooks.onDialogClose();
      expect(p.exits).toHaveLength(1);
      expect(p.exits[0].reason).toBe('desync');
      expect(p.exits[0].message).toContain('disagreed');
    }
  }, 60000);
});

describe('NetBrawlController — leaving and the host', () => {
  it('the host leaving announces itself: clients get the "host left" dialog at once (not after the stall timeout)', async () => {
    const rig = await ControllerRig.create({ n: 3, seed: 13, names: ['Ann', 'Bob', 'Cy'] });
    rig.run(1500);
    rig.peer(0).controller.leave();
    expect(rig.peer(0).exits[0].reason).toBe('peer-left');
    rig.run(100);
    for (const slot of [1, 2]) {
      const p = rig.peer(slot);
      expect(p.controller.phase).toBe('dialog');
      expect(p.kit.netHud.dialogs[0].title).toBe('The host left');
      expect(p.kit.netHud.dialogs[0].message).toContain('Ann');
      p.kit.netHud.hooks.onDialogClose();
      expect(p.exits).toEqual([{ reason: 'host-left', message: p.kit.netHud.dialogs[0].message }]);
    }
  });

  it('a client saying goodbye does not stop the others, and a goodbye after the result is ignored', async () => {
    const rig = await ControllerRig.create({ n: 3, stocks: 1, timeLimitS: 10, seed: 14 });
    rig.run(1500);
    rig.peer(2).controller.leave();
    rig.run(200);
    expect(rig.peer(0).controller.phase).toBe('playing');
    expect(rig.peer(1).controller.phase).toBe('playing');

    const rig2 = await ControllerRig.create({ n: 2, stocks: 1, timeLimitS: 8, seed: 15 });
    rig2.run(240000, () => allIn(rig2, 'results'));
    expect(allIn(rig2, 'results')).toBe(true);
    rig2.channels[0].broadcast('reliable', NET_BRAWL_BYE, new Uint8Array(0));
    rig2.run(200);
    expect(rig2.peer(1).controller.phase).toBe('results');
    expect(rig2.peer(1).exits).toHaveLength(0);
    expect(rig2.peer(1).kit.netHud.dialogs).toHaveLength(0);
  }, 60000);

  it('the session ending on its own with the host gone shows the dialog too', async () => {
    const rig = await ControllerRig.create({ n: 2, seed: 16, names: ['Ann', 'Bob'] });
    rig.run(1200);
    rig.disconnect(0); // the room closed: the link drops without a goodbye
    rig.run(300);
    const b = rig.peer(1);
    expect(b.controller.phase).toBe('dialog');
    expect(b.kit.netHud.dialogs[0].title).toBe('The host left');
    b.kit.netHud.hooks.onDialogClose();
    expect(b.exits[0].reason).toBe('host-left');
  });
});

describe('NetBrawlController — peers keep the same pace', () => {
  it('two peers end up on (nearly) the same frame and every checksum agrees (no desync dialog in a long perfect-network run)', async () => {
    const rig = await ControllerRig.create({ n: 2, stocks: 5, timeLimitS: 0, seed: 17 });
    rig.run(12000);
    const [a, b]: RigPeer[] = [rig.peer(0), rig.peer(1)];
    expect(Math.abs(a.controller.session.frame - b.controller.session.frame)).toBeLessThanOrEqual(4);
    expect(a.controller.session.stats.checksumsCompared).toBeGreaterThan(5);
    expect(a.controller.session.isDesynced || b.controller.session.isDesynced).toBe(false);
    expect(a.kit.netHud.last?.pings[0].name).toBe('P1');
  });
});
