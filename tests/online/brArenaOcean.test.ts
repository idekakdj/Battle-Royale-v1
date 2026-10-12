/**
 * v1.9 online Battle Royale on the OCEAN DOME (WP-O4): the host's map pick ('ocean') through the room settings, the reliable start
 * message, the wire parsers, the room-picker cards, the data fingerprint and a full headless host + 2 clients match whose
 * standings agree on every machine. (The serpent's own wire format / events are covered by brNetOcean.test.ts.)
 */

import { describe, expect, it } from 'vitest';
import { ARENAS, OCEAN_ARENA } from '../../src/config/arenas';
import { ARENA_IDS } from '../../src/core/types';
import { DEFAULT_ROOM_SETTINGS } from '../../src/online/room/types';
import { parseSettings, parseStart } from '../../src/online/room/messages';
import { fingerprintData, fnv1a32, hex32, localVersions, stableStringify } from '../../src/online/room/fingerprint';
import { mapPickerItems, settingsKey } from '../../src/online/ui/viewModel';
import { netMatchConfig, startArena } from '../../src/online/br/netRoster';
import type { OnlineStart } from '../../src/online/types';
import { parseArena } from '../../src/ui/storage';
import { Rig } from './roomHarness';
import { disposeSession, makeDriverSession } from './brControllerHarness';

describe('ocean in the room layer', () => {
  it('parseSettings accepts "ocean" (and still rejects look-alikes)', () => {
    expect(parseSettings({ br: { arena: 'ocean' } }, DEFAULT_ROOM_SETTINGS).br.arena).toBe('ocean');
    const base = { ...DEFAULT_ROOM_SETTINGS, br: { ...DEFAULT_ROOM_SETTINGS.br, arena: 'ocean' as const } };
    for (const bad of ['Ocean', 'ocean ', 'sea', '', 7, null, ['ocean']]) {
      expect(parseSettings({ br: { arena: bad } }, base).br.arena).toBe('ocean');
      expect(parseSettings({ br: { arena: bad } }, DEFAULT_ROOM_SETTINGS).br.arena).toBe('colosseum');
    }
  });

  it('parseStart carries "ocean" through the start message', () => {
    const slots = [
      { slot: 0, peerId: 'a', name: 'A', animal: 'lion', kind: 'human' },
      { slot: 1, peerId: null, name: 'B', animal: 'eagle', kind: 'bot' },
    ];
    const wire = (br: unknown): unknown => ({ mode: 'battleRoyale', seed: 5, slots, hostPeerId: 'a', br });
    expect(parseStart(wire({ difficulty: 4, arena: 'ocean' }))?.br).toEqual({ difficulty: 4, arena: 'ocean' });
    expect(parseStart(wire({ difficulty: 4, arena: 'Ocean' }))?.br).toEqual({ difficulty: 4, arena: 'colosseum' });
  });

  it('startArena / netMatchConfig: the ocean adds the arena to the World config', () => {
    const base: OnlineStart = { mode: 'battleRoyale', seed: 1, slots: [], localSlot: 0, hostPeerId: 'h' };
    expect(startArena({ ...base, br: { difficulty: 2, arena: 'ocean' } })).toBe('ocean');
    const roster = [{ animal: 'lion' as const, isPlayer: true }];
    expect(netMatchConfig({ ...base, br: { difficulty: 3, arena: 'ocean' } }, roster, 3)).toEqual({ roster, difficulty: 3, arena: 'ocean' });
  });

  it('the stored map choice (gk-arena) parses "ocean" too, and every ArenaId is a valid room map', () => {
    expect(parseArena('ocean')).toBe('ocean');
    for (const id of ARENA_IDS) expect(parseSettings({ br: { arena: id } }, DEFAULT_ROOM_SETTINGS).br.arena).toBe(id);
  });
});

describe('room picker: three cards', () => {
  it('lists colosseum | jungle | ocean with the ArenaDef copy; the pick is part of the settings key', () => {
    const items = mapPickerItems('ocean');
    expect(items.map((i) => i.id)).toEqual(['colosseum', 'jungle', 'ocean']);
    expect(items.map((i) => i.selected)).toEqual([false, false, true]);
    expect(items[2].name).toBe('Ocean Dome');
    expect(items[2].blurb).toBe(ARENAS.ocean.blurb);
    const s = (arena: 'colosseum' | 'jungle' | 'ocean'): string =>
      settingsKey({ role: 'host', mode: 'battleRoyale', phase: 'lobby', settings: { ...DEFAULT_ROOM_SETTINGS, br: { ...DEFAULT_ROOM_SETTINGS.br, arena } }, slots: [], botFill: 0 } as never);
    expect(new Set([s('colosseum'), s('jungle'), s('ocean')]).size).toBe(3);
  });
});

describe('host picks the ocean (real rooms over the loopback network)', () => {
  it('EVERY machine gets OnlineStart.br.arena = "ocean" (client cannot change it, the pick survives the match)', async () => {
    const rig = new Rig({ latencyMs: 20 });
    const { host, clients } = await rig.lobby(2);
    expect(clients[0].room.setSettings({ br: { arena: 'ocean' } })).toBe(false);
    host.room.setSettings({ br: { arena: 'ocean', botLevel: 3 } });
    await rig.run(200);
    for (const p of [host, ...clients]) expect(p.state.settings.br.arena).toBe('ocean');
    await rig.startAll(host, clients);
    for (const p of [host, ...clients]) {
      const { start } = p.starts[0];
      expect(start.mode).toBe('battleRoyale');
      expect(start.br).toEqual({ difficulty: 3, arena: 'ocean' });
      expect(startArena(start)).toBe('ocean');
    }
    host.room.backToRoom();
    await rig.run(300);
    expect(host.state.settings.br.arena).toBe('ocean');
    expect(clients[0].state.settings.br.arena).toBe('ocean');
  });

  it('a room hosted with the ocean preset starts on it', async () => {
    const rig = new Rig();
    const host = await rig.host('Ann', 'lion', { settings: { br: { arena: 'ocean' } } });
    expect(host.state.settings.br.arena).toBe('ocean');
  });
});

describe('data fingerprint covers the ocean', () => {
  it('moving one ramp changes the Battle Royale fingerprint (a peer with different ocean data cannot join)', () => {
    const data = fingerprintData('battleRoyale') as Record<string, unknown>;
    const hf = OCEAN_ARENA.heightfield ?? [];
    expect(hf.length).toBeGreaterThan(0);
    const moved = {
      ...data,
      arenas: { ...ARENAS, ocean: { ...OCEAN_ARENA, heightfield: hf.map((p, i) => (i === hf.length - 1 && p.kind === 'ramp' ? { ...p, h1: p.h1 + 0.1 } : p)) } },
    };
    const otherFp = hex32(fnv1a32(stableStringify(moved)));
    expect(otherFp).not.toBe(localVersions().fingerprints.battleRoyale);
    // and the serpent-hazard flag is part of the data too
    const noHazard = { ...data, arenas: { ...ARENAS, ocean: { ...OCEAN_ARENA, hazards: undefined } } };
    expect(hex32(fnv1a32(stableStringify(noHazard)))).not.toBe(localVersions().fingerprints.battleRoyale);
  });
});

describe('headless Battle Royale on the Ocean Dome (host + 2 clients over the loopback network)', () => {
  it('every machine plays the ocean and the standings agree', async () => {
    const s = await makeDriverSession({ fighters: 4, humanSlots: [0, 1, 2], difficulty: 3, arena: 'ocean', seed: 909 });
    try {
      expect(s.host.arena).toBe('ocean');
      for (const c of s.clients) expect(c.driver.arena).toBe('ocean');
      expect(s.host.simSnapshot().fighters).toHaveLength(4);
      // the host's World runs on the ocean seats (the seabed ring, r 24)
      const first = s.host.simSnapshot().fighters[0].pos;
      expect(OCEAN_ARENA.spawns.some((p) => Math.hypot(p.x - first.x, p.z - first.z) < 0.01)).toBe(true);
      expect(Math.hypot(first.x, first.z)).toBeCloseTo(24, 1);

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
  }, 180_000);
});
