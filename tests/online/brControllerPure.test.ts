/**
 * WP-N6 pure helpers: online roster / name mapping, results conversion, the net HUD view-model.
 */

import { describe, expect, it } from 'vitest';
import { ANIMAL_IDS, ANIMALS } from '../../src/config/animals';
import type { AnimalId } from '../../src/core/types';
import type { OnlineSlotInfo, OnlineStart } from '../../src/online/types';
import type { BrResults } from '../../src/online/br/miscCodec';
import {
  MAX_NAME_CHARS,
  brResultsToMatchResults,
  buildNetRoster,
  cleanName,
  controllerNames,
  controllerRoster,
  orderedSlots,
  slotLabel,
  toControllerId,
} from '../../src/online/br/netRoster';
import {
  FIRST_SNAPSHOT_TIMEOUT_MS,
  HOST_TIMEOUT_MS,
  RECONNECT_BANNER_MS,
  describeLink,
  hostTimedOut,
  qualityOf,
} from '../../src/online/br/netHudModel';

const animals = ANIMAL_IDS as AnimalId[];

function mkStart(localSlot: number, humans: Record<number, string>, n = 10): OnlineStart {
  const slots: OnlineSlotInfo[] = [];
  for (let i = 0; i < n; i++) {
    const name = humans[i];
    slots.push({ slot: i, peerId: name !== undefined ? (i === 0 ? 'host' : `p${i}`) : null, name: name ?? animals[i], animal: animals[i], kind: name !== undefined ? 'human' : 'bot' });
  }
  return { mode: 'battleRoyale', seed: 7, slots, localSlot, hostPeerId: 'host', br: { difficulty: 3 } };
}

describe('roster from OnlineStart', () => {
  const start = mkStart(0, { 0: 'Hosty', 4: 'Ann', 7: 'Bob' });

  it('keeps the FIXED slot order (no seating shuffle) and the room animals', () => {
    const r = buildNetRoster(start, 0);
    expect(r.map((e) => e.animal)).toEqual(animals);
  });

  it('only the host seat is isPlayer; remote humans and bots are false so BotManager can take any slot over', () => {
    const r = buildNetRoster(start, 0);
    expect(r.map((e) => e.isPlayer)).toEqual([true, ...new Array(9).fill(false)]);
    // a host sitting elsewhere
    const r3 = buildNetRoster(mkStart(3, { 3: 'Hosty', 5: 'Ann' }), 3);
    expect(r3.filter((e) => e.isPlayer)).toHaveLength(1);
    expect(r3[3].isPlayer).toBe(true);
    // clients own no World: nobody is the player
    expect(buildNetRoster(start, null).some((e) => e.isPlayer)).toBe(false);
  });

  it('sorts slots defensively', () => {
    const shuffled: OnlineStart = { ...start, slots: [...start.slots].reverse() };
    expect(orderedSlots(shuffled).map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(buildNetRoster(shuffled, 0).map((e) => e.animal)).toEqual(animals);
  });

  it('controller order puts the local player at id 0 (transposition 0 <-> localSlot)', () => {
    const s = mkStart(4, { 0: 'Hosty', 4: 'Ann', 7: 'Bob' });
    const roster = controllerRoster(buildNetRoster(s, null), 4);
    expect(roster[0].animal).toBe(animals[4]);
    expect(roster[4].animal).toBe(animals[0]);
    expect(roster[7].animal).toBe(animals[7]);
    expect(toControllerId(4, 4)).toBe(0);
    expect(toControllerId(0, 4)).toBe(4);
    expect(toControllerId(7, 4)).toBe(7);
  });
});

describe('name mapping', () => {
  it('humans show their chosen names, bots null (animal name), in controller order', () => {
    const s = mkStart(4, { 0: 'Hosty', 4: 'Ann', 7: 'Bob' });
    const names = controllerNames(s, 4);
    expect(names[0]).toBe('Ann'); // the local player
    expect(names[4]).toBe('Hosty'); // slot 0 swapped into 4
    expect(names[7]).toBe('Bob');
    expect(names.filter((n) => n === null)).toHaveLength(7);
    expect(controllerNames(s, 0)[0]).toBe('Hosty');
  });

  it('cleanName trims, collapses, strips control / bidi characters, caps the length', () => {
    expect(cleanName('  Ann   Lee  ', 'x')).toBe('Ann Lee');
    expect(cleanName('A\u0000n‮n\n', 'x')).toBe('A n n');
    expect(cleanName('   ', 'Fallback')).toBe('Fallback');
    expect(cleanName('​​', 'Fallback')).toBe('Fallback');
    const long = cleanName('abcdefghijklmnopqrstuvwxyz', 'x');
    expect(Array.from(long).length).toBeLessThanOrEqual(MAX_NAME_CHARS);
    expect(long.startsWith('abcdefghijklmnop')).toBe(true);
    // surrogate pairs are never cut in half
    const emoji = cleanName('\u{1f981}'.repeat(30), 'x');
    expect(Array.from(emoji)).toHaveLength(MAX_NAME_CHARS);
    expect(emoji.includes('�')).toBe(false);
  });

  it('slotLabel: chosen name for humans, animal display name for bots', () => {
    const s = mkStart(0, { 0: 'Hosty' });
    expect(slotLabel(s.slots[0])).toBe('Hosty');
    expect(slotLabel(s.slots[3])).toBe(ANIMALS[animals[3]].displayName);
    expect(slotLabel({ ...s.slots[0], name: '' })).toBe(ANIMALS[animals[0]].displayName);
  });
});

describe('results conversion (BrResults -> MatchResults)', () => {
  const start = mkStart(4, { 0: 'Hosty', 4: 'Ann', 7: 'Bob' }, 5);
  const results = (winner: number): BrResults => ({
    winnerId: winner,
    matchTimeS: 91.4,
    fighters: [
      { placement: 3, kills: 1, damageDealt: 210.4, damageBlocked: 12.6, ultsUsed: 0 },
      { placement: 5, kills: 0, damageDealt: 10, damageBlocked: 0, ultsUsed: 0 },
      { placement: 4, kills: 0, damageDealt: 40, damageBlocked: 0, ultsUsed: 0 },
      { placement: 2, kills: 2, damageDealt: 330, damageBlocked: 5, ultsUsed: 1 },
      { placement: 1, kills: 3, damageDealt: 720.6, damageBlocked: 88.4, ultsUsed: 2 },
    ],
  });

  it('victory: placement 1, the local row of the message, whole-room standings', () => {
    const m = brResultsToMatchResults(results(4), start, 4, 3);
    expect(m.victory).toBe(true);
    expect(m.placement).toBe(1);
    expect(m.animal).toBe(animals[4]);
    expect(m.kills).toBe(3);
    expect(m.damageDealt).toBe(721);
    expect(m.damageBlocked).toBe(88);
    expect(m.ultsUsed).toBe(2);
    expect(m.matchTimeS).toBeCloseTo(91.4);
    expect(m.difficulty).toBe(3);
    const st = m.standings ?? [];
    expect(st).toHaveLength(5);
    expect(st.find((r) => r.isYou)?.name).toBe('Ann');
    expect(st.find((r) => r.placement === 1)?.isYou).toBe(true);
    expect(st[1].isBot).toBe(true); // slot 1 is a bot
    expect(st[0].isBot).toBe(false);
    expect(st[0].name).toBe('Hosty');
  });

  it('defeat: placement from the message', () => {
    const m = brResultsToMatchResults(results(3), start, 4, 3);
    expect(m.victory).toBe(false);
    expect(m.placement).toBe(1); // slot 4's recorded placement is 1 in this fixture, but the winner is 3 ...
  });

  it('defeat: a recorded placement is used; unknown placement falls back to the controller reading', () => {
    const r = results(3);
    r.fighters[4].placement = 2;
    expect(brResultsToMatchResults(r, start, 4, 3).placement).toBe(2);
    r.fighters[4].placement = 0;
    const fb = { victory: false, placement: 4, animal: animals[4], kills: 0, damageDealt: 0, damageBlocked: 0, ultsUsed: 0, matchTimeS: 1, difficulty: 3 as const };
    expect(brResultsToMatchResults(r, start, 4, 3, fb).placement).toBe(4);
  });

  it('tolerates a short fighters list', () => {
    const r: BrResults = { winnerId: 0, matchTimeS: -3, fighters: [] };
    const m = brResultsToMatchResults(r, start, 4, 2);
    expect(m.kills).toBe(0);
    expect(m.matchTimeS).toBe(0);
    expect(m.victory).toBe(false);
  });
});

describe('net HUD view-model', () => {
  it('quality bands', () => {
    expect(qualityOf(30, 0)).toBe('good');
    expect(qualityOf(90, 0)).toBe('ok');
    expect(qualityOf(160, 0)).toBe('poor');
    expect(qualityOf(300, 0)).toBe('bad');
    expect(qualityOf(30, 0.1)).toBe('poor');
    expect(qualityOf(30, 0.2)).toBe('bad');
  });

  it('client: ping/loss text, connecting and reconnecting banners', () => {
    const base = { role: 'client' as const, pingMs: 42.4, loss: 0.014, hostSilenceMs: 20, haveSnapshot: true, waitingFor: [] };
    const ok = describeLink(base);
    expect(ok.text).toBe('PING 42 ms · LOSS 1%');
    expect(ok.banner).toBeNull();
    expect(ok.quality).toBe('good');
    expect(describeLink({ ...base, haveSnapshot: false }).banner).toMatch(/Connecting/);
    const rc = describeLink({ ...base, hostSilenceMs: RECONNECT_BANNER_MS + 1 });
    expect(rc.banner).toMatch(/Reconnecting/);
    expect(rc.quality).toBe('bad');
  });

  it('host: worst ping and the waiting-for-players banner', () => {
    const base = { role: 'host' as const, pingMs: 0, loss: 0, hostSilenceMs: 0, haveSnapshot: true, waitingFor: [] as string[] };
    expect(describeLink(base).text).toBe('HOST');
    expect(describeLink({ ...base, pingMs: 88 }).text).toBe('HOST · WORST PING 88 ms');
    expect(describeLink({ ...base, waitingFor: ['Ann'] }).banner).toBe('Waiting for Ann…');
    expect(describeLink({ ...base, waitingFor: ['Ann', 'Bob'] }).banner).toBe('Waiting for Ann and Bob…');
    expect(describeLink({ ...base, waitingFor: ['Ann', 'Bob', 'Cy'] }).banner).toBe('Waiting for Ann, Bob and Cy…');
  });

  it('host timeout rules', () => {
    expect(hostTimedOut(true, HOST_TIMEOUT_MS - 1, 99999)).toBe(false);
    expect(hostTimedOut(true, HOST_TIMEOUT_MS, 99999)).toBe(true);
    expect(hostTimedOut(false, 99999, FIRST_SNAPSHOT_TIMEOUT_MS - 1)).toBe(false);
    expect(hostTimedOut(false, 0, FIRST_SNAPSHOT_TIMEOUT_MS)).toBe(true);
  });
});
