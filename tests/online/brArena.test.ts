/**
 * v1.8 online Battle Royale map: the host picks it in the room (`RoomSettings.br.arena`), it travels in the reliable JSON start
 * message (`OnlineStart.br.arena`), and the host's World/BotManager/seating AND every client's scene context use it. Also: the
 * room-picker view model, wire validation, the data-fingerprint rejection and a full headless host + 2 clients match on the jungle.
 */

import { describe, expect, it } from 'vitest';
import { ARENAS, COLOSSEUM_ARENA, JUNGLE_ARENA } from '../../src/config/arenas';
import { DEFAULT_ROOM_SETTINGS, RoomError } from '../../src/online/room/types';
import { parseSettings, parseStart } from '../../src/online/room/messages';
import { fingerprintData, fnv1a32, hex32, localVersions, stableStringify } from '../../src/online/room/fingerprint';
import { mapPickerItems, settingsKey } from '../../src/online/ui/viewModel';
import { netMatchConfig, startArena } from '../../src/online/br/netRoster';
import type { OnlineStart } from '../../src/online/types';
import { Rig } from './roomHarness';
import { disposeSession, makeDriverSession } from './brControllerHarness';

async function rejection(p: Promise<unknown>): Promise<RoomError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RoomError);
    return e as RoomError;
  }
  throw new Error('expected a rejection');
}

describe('room settings: br.arena', () => {
  it('defaults to the colosseum', () => {
    expect(DEFAULT_ROOM_SETTINGS.br.arena).toBe('colosseum');
  });

  it('parseSettings keeps a valid arena and falls back to the current one for anything else', () => {
    const base = { ...DEFAULT_ROOM_SETTINGS, br: { ...DEFAULT_ROOM_SETTINGS.br, arena: 'jungle' as const } };
    expect(parseSettings({ br: { arena: 'colosseum' } }, base).br.arena).toBe('colosseum');
    expect(parseSettings({ br: { arena: 'jungle' } }, DEFAULT_ROOM_SETTINGS).br.arena).toBe('jungle');
    for (const bad of ['volcano', '', 7, null, {}, ['jungle'], 'JUNGLE']) {
      expect(parseSettings({ br: { arena: bad } }, base).br.arena).toBe('jungle');
      expect(parseSettings({ br: { arena: bad } }, DEFAULT_ROOM_SETTINGS).br.arena).toBe('colosseum');
    }
    // a message from a build that predates the field leaves the setting alone
    expect(parseSettings({ br: { botLevel: 3 } }, base).br.arena).toBe('jungle');
  });

  it('parseStart carries the map and tolerates a missing / unknown one', () => {
    const slots = [
      { slot: 0, peerId: 'a', name: 'A', animal: 'lion', kind: 'human' },
      { slot: 1, peerId: null, name: 'B', animal: 'eagle', kind: 'bot' },
    ];
    const wire = (br: unknown): unknown => ({ mode: 'battleRoyale', seed: 5, slots, hostPeerId: 'a', br });
    expect(parseStart(wire({ difficulty: 3, arena: 'jungle' }))?.br).toEqual({ difficulty: 3, arena: 'jungle' });
    expect(parseStart(wire({ difficulty: 3 }))?.br).toEqual({ difficulty: 3, arena: 'colosseum' });
    expect(parseStart(wire({ difficulty: 3, arena: 'moon' }))?.br).toEqual({ difficulty: 3, arena: 'colosseum' });
  });

  it('startArena / netMatchConfig: colosseum builds the exact pre-1.8 World config, jungle adds the arena', () => {
    const base: OnlineStart = { mode: 'battleRoyale', seed: 1, slots: [], localSlot: 0, hostPeerId: 'h' };
    expect(startArena(base)).toBe('colosseum');
    expect(startArena({ ...base, br: { difficulty: 2 } })).toBe('colosseum');
    expect(startArena({ ...base, br: { difficulty: 2, arena: 'jungle' } })).toBe('jungle');
    expect(startArena({ ...base, br: { difficulty: 2, arena: 'x' as never } })).toBe('colosseum');
    const roster = [{ animal: 'lion' as const, isPlayer: true }];
    expect(netMatchConfig({ ...base, br: { difficulty: 2, arena: 'colosseum' } }, roster, 2)).toEqual({ roster, difficulty: 2 });
    expect(Object.keys(netMatchConfig({ ...base, br: { difficulty: 2, arena: 'colosseum' } }, roster, 2))).not.toContain('arena');
    expect(netMatchConfig({ ...base, br: { difficulty: 4, arena: 'jungle' } }, roster, 4)).toEqual({ roster, difficulty: 4, arena: 'jungle' });
  });
});

describe('room picker view model', () => {
  it('lists every arena in order with its ArenaDef copy; exactly one is selected', () => {
    const items = mapPickerItems('jungle');
    expect(items.map((i) => i.id)).toEqual(['colosseum', 'jungle']);
    expect(items.map((i) => i.selected)).toEqual([false, true]);
    expect(items[1].name).toBe(ARENAS.jungle.name);
    expect(items[1].blurb).toBe(ARENAS.jungle.blurb);
    expect(mapPickerItems('colosseum').map((i) => i.selected)).toEqual([true, false]);
  });

  it('changing the map changes the settings key (the panel rebuilds)', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann');
    const before = settingsKey(host.state);
    host.room.setSettings({ br: { arena: 'jungle' } });
    expect(settingsKey(host.state)).not.toBe(before);
  });
});

describe('OnlineRoom: the host picks the map', () => {
  it('the pick is visible to every machine, only the host can change it, and bad values are refused', async () => {
    const rig = new Rig({ latencyMs: 15 });
    const { host, clients } = await rig.lobby(2);
    for (const p of [host, ...clients]) expect(p.state.settings.br.arena).toBe('colosseum');

    expect(host.room.setSettings({ br: { arena: 'jungle' } })).toBe(true);
    await rig.run(200);
    for (const p of [host, ...clients]) expect(p.state.settings.br.arena).toBe('jungle');

    // a client cannot change it
    expect(clients[0].room.setSettings({ br: { arena: 'colosseum' } })).toBe(false);
    await rig.run(200);
    for (const p of [host, ...clients]) expect(p.state.settings.br.arena).toBe('jungle');

    // an unknown map from the host's own API is clamped back to the current one
    host.room.setSettings({ br: { arena: 'nowhere' as never } });
    await rig.run(100);
    expect(host.state.settings.br.arena).toBe('jungle');
    // the other settings are untouched by a map change
    expect(host.state.settings.br.botLevel).toBe(DEFAULT_ROOM_SETTINGS.br.botLevel);
    expect(host.state.settings.br.fillBots).toBe(true);
  });

  it('a room hosted with a preset map starts on it (initial host options)', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann', 'lion', { settings: { br: { arena: 'jungle' } } });
    expect(host.state.settings.br.arena).toBe('jungle');
  });

  it('host picks the jungle -> EVERY machine\'s OnlineStart.br.arena is "jungle" (the same payload everywhere)', async () => {
    const rig = new Rig({ latencyMs: 20 });
    const { host, clients } = await rig.lobby(2);
    host.room.setSettings({ br: { arena: 'jungle', botLevel: 3 } });
    await rig.run(200);
    await rig.startAll(host, clients);
    const all = [host, ...clients];
    for (const p of all) {
      const { start } = p.starts[0];
      expect(start.mode).toBe('battleRoyale');
      expect(start.br).toEqual({ difficulty: 3, arena: 'jungle' });
      expect(startArena(start)).toBe('jungle');
      expect(start.cl).toBeUndefined();
    }
    expect(new Set(all.map((p) => p.starts[0].start.seed)).size).toBe(1);
  });

  it('a colosseum room says so explicitly, and a Champions League room has no BR payload at all', async () => {
    const rig = new Rig({ latencyMs: 10 });
    const a = await rig.lobby(1);
    await rig.startAll(a.host, a.clients);
    expect(a.host.starts[0].start.br).toEqual({ difficulty: 2, arena: 'colosseum' });
    expect(a.clients[0].starts[0].start.br).toEqual({ difficulty: 2, arena: 'colosseum' });

    const rig2 = new Rig({ latencyMs: 10 });
    const b = await rig2.lobby(1);
    b.host.room.setSettings({ br: { arena: 'jungle' } }); // a BR-only setting must not leak into Champions League
    b.host.room.setMode('championsLeague');
    await rig2.run(200);
    await rig2.startAll(b.host, b.clients);
    for (const p of [b.host, ...b.clients]) {
      expect(p.starts[0].start.mode).toBe('championsLeague');
      expect(p.starts[0].start.br).toBeUndefined();
      expect(p.starts[0].start.cl).toBeDefined();
    }
  });

  it('back in the lobby the pick survives the match', async () => {
    const rig = new Rig({ latencyMs: 10 });
    const { host, clients } = await rig.lobby(1);
    host.room.setSettings({ br: { arena: 'jungle' } });
    await rig.run(100);
    await rig.startAll(host, clients);
    host.room.backToRoom();
    await rig.run(300);
    expect(host.state.settings.br.arena).toBe('jungle');
    expect(clients[0].state.settings.br.arena).toBe('jungle');
  });
});

describe('data fingerprint: mismatched arena data is rejected', () => {
  it('a peer whose jungle differs (different Battle Royale fingerprint) cannot join', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann');
    // what a build with a tree moved 0.1 m would report
    const data = fingerprintData('battleRoyale') as Record<string, unknown>;
    const moved = {
      ...data,
      arenas: { ...ARENAS, jungle: { ...JUNGLE_ARENA, circles: JUNGLE_ARENA.circles.map((c, i) => (i === 0 ? { ...c, x: c.x + 0.1 } : c)) } },
    };
    const otherFp = hex32(fnv1a32(stableStringify(moved)));
    expect(otherFp).not.toBe(host.state.versions.fingerprints.battleRoyale);
    const err = await rejection(
      rig.joinRoom(host.state.code, 'Bob', 'eagle', {
        versions: { fingerprints: { battleRoyale: otherFp, championsLeague: localVersions().fingerprints.championsLeague } },
      }),
    );
    expect(err.code).toBe('version-mismatch');
    expect(err.details?.mismatch).toEqual(['fingerprint:battleRoyale']);
    expect(host.state.slots).toHaveLength(1);
  });

  it('the same data joins fine', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann');
    const bob = await rig.join(host.state.code, 'Bob', 'eagle');
    await rig.run(100);
    expect(bob.state.slots).toHaveLength(2);
  });
});

describe('headless Battle Royale on the jungle (host + 2 clients over the loopback network)', () => {
  it('every machine plays the jungle and the standings agree', async () => {
    const s = await makeDriverSession({ fighters: 4, humanSlots: [0, 1, 2], difficulty: 3, arena: 'jungle', seed: 777 });
    try {
      expect(s.host.arena).toBe('jungle');
      expect(s.host.simSnapshot().fighters).toHaveLength(4);
      for (const c of s.clients) expect(c.driver.arena).toBe('jungle');
      // the host's World runs on the jungle seats (4 of the 10 seat ring)
      const seats = JUNGLE_ARENA.spawns;
      const first = s.host.simSnapshot().fighters[0].pos;
      expect(seats.some((p) => Math.hypot(p.x - first.x, p.z - first.z) < 0.01)).toBe(true);
      expect(Math.hypot(first.x, first.z)).toBeCloseTo(20, 1);

      s.runToEnd(30000);
      expect(s.host.simSnapshot().matchOver).toBe(true);
      const hostRes = s.host.results();
      expect(hostRes).not.toBeNull();
      if (hostRes === null) return;
      const places = hostRes.fighters.map((f) => f.placement).sort((a, b) => a - b);
      expect(new Set(places).size).toBe(4);
      expect(hostRes.fighters[hostRes.winnerId].placement).toBe(1);
      for (const c of s.clients) {
        const res = c.driver.results();
        expect(res).not.toBeNull();
        expect(res?.winnerId).toBe(hostRes.winnerId);
        expect(res?.fighters.map((f) => f.placement)).toEqual(hostRes.fighters.map((f) => f.placement));
      }
    } finally {
      disposeSession(s);
    }
  }, 120_000);

  it('a colosseum session (no arena in the start) is unchanged: colosseum seats, colosseum arena', async () => {
    const s = await makeDriverSession({ fighters: 4, humanSlots: [0, 1], seed: 778 });
    try {
      expect(s.host.arena).toBe('colosseum');
      expect(s.clients[0].driver.arena).toBe('colosseum');
      const p = s.host.simSnapshot().fighters[0].pos;
      expect(Math.hypot(p.x, p.z)).toBeCloseTo(COLOSSEUM_ARENA.spawnRing, 1);
    } finally {
      disposeSession(s);
    }
  });
});
