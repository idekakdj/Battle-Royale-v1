import { describe, expect, it } from 'vitest';
import { ANIMAL_IDS } from '../../src/config/animals';
import type { AnimalId } from '../../src/core/types';
import { DEFAULT_ROOM_SETTINGS, ROOM_LIMITS, type RoomSlot, type RoomState, type StartBlocker } from '../../src/online/room/types';
import {
  buildRoomView,
  describeStartBlockers,
  fighterAvailability,
  rosterCounts,
  settingsKey,
  statusLine,
} from '../../src/online/ui/viewModel';

const VERSIONS = { protocol: 1, appVersion: '1.4.1', fingerprints: { championsLeague: 'a', battleRoyale: 'b' } };

function human(id: string, name: string, animal: AnimalId, o: Partial<RoomSlot> = {}): RoomSlot {
  return { id, kind: 'human', peerId: id, name, animal, ready: false, pingMs: 30, isHost: false, isLocal: false, ...o };
}

function bot(n: number, animal: AnimalId): RoomSlot {
  return { id: `bot:${n}`, kind: 'bot', peerId: null, name: animal, animal, ready: true, pingMs: 0, isHost: false, isLocal: false };
}

function makeState(slots: RoomSlot[], o: Partial<RoomState> = {}): RoomState {
  const blockers: StartBlocker[] = o.startBlockers ?? [];
  return {
    rev: 1,
    code: 'K7P4Q',
    role: 'host',
    phase: 'lobby',
    mode: 'championsLeague',
    settings: structuredClone(DEFAULT_ROOM_SETTINGS) as RoomState['settings'],
    slots,
    localPeerId: slots.find((s) => s.isLocal)?.id ?? '',
    hostPeerId: slots.find((s) => s.isHost)?.id ?? '',
    versions: VERSIONS,
    hostVersions: VERSIONS,
    botFill: 0,
    canStart: blockers.length === 0,
    startBlockers: blockers,
    ...o,
  };
}

const host = (o: Partial<RoomSlot> = {}): RoomSlot => human('h', 'Ann', 'lion', { isHost: true, isLocal: true, ready: true, pingMs: 0, ...o });

describe('start blockers as human text', () => {
  it('need-players', () => {
    const s = makeState([host()], { startBlockers: ['need-players'] });
    expect(describeStartBlockers(s)).toEqual(['Need at least 2 players']);
  });

  it('names the players who still have to ready up', () => {
    const one = makeState([host(), human('b', 'Bob', 'eagle'), human('c', 'Cy', 'hippo', { ready: true })], { startBlockers: ['not-all-ready'] });
    expect(describeStartBlockers(one)).toEqual(['Waiting for Bob to ready up']);
    const two = makeState([host(), human('b', 'Bob', 'eagle'), human('c', 'Cy', 'hippo'), human('d', 'Di', 'rhino', { ready: true })], { startBlockers: ['not-all-ready'] });
    expect(describeStartBlockers(two)).toEqual(['Waiting for Bob and Cy to ready up']);
    const three = makeState([host(), human('b', 'Bob', 'eagle'), human('c', 'Cy', 'hippo'), human('d', 'Di', 'rhino')], { startBlockers: ['not-all-ready'] });
    expect(describeStartBlockers(three)).toEqual(['Waiting for Bob, Cy and Di to ready up']);
  });

  it('wrong-phase while starting / in a match, and nothing when the host can start', () => {
    expect(describeStartBlockers(makeState([host(), human('b', 'Bob', 'eagle')], { phase: 'starting', startBlockers: ['wrong-phase'] }))).toEqual(['Starting…']);
    expect(describeStartBlockers(makeState([host()], { phase: 'inMatch', startBlockers: ['wrong-phase'] }))).toEqual(['A match is in progress']);
    expect(describeStartBlockers(makeState([host(), human('b', 'Bob', 'eagle', { ready: true })]))).toEqual([]);
  });

  it('combines several blockers in order', () => {
    const s = makeState([host()], { startBlockers: ['need-players', 'not-all-ready'] });
    expect(describeStartBlockers(s)).toHaveLength(2);
    expect(describeStartBlockers(s)[0]).toMatch(/at least 2/);
  });
});

describe('status line', () => {
  it('host: Start hint or the blockers', () => {
    const ready = makeState([host(), human('b', 'Bob', 'eagle', { ready: true })]);
    expect(statusLine(ready)).toMatch(/Press Start/);
    const wait = makeState([host(), human('b', 'Bob', 'eagle')], { startBlockers: ['not-all-ready'] });
    expect(statusLine(wait)).toBe('Waiting for Bob to ready up');
    expect(statusLine(makeState([host(), human('b', 'Bob', 'eagle')], { phase: 'starting', startBlockers: ['wrong-phase'] }))).toBe('Starting…');
  });

  it('client: tells you to press Ready, then waits for the others / the host', () => {
    const me = human('b', 'Bob', 'eagle', { isLocal: true });
    const notReady = makeState([host({ isLocal: false }), me], { role: 'client', canStart: false, startBlockers: ['not-host'] });
    expect(statusLine(notReady)).toMatch(/Press Ready/);
    const readyMe = { ...me, ready: true };
    const other = human('c', 'Cy', 'hippo');
    expect(statusLine(makeState([host({ isLocal: false }), readyMe, other], { role: 'client', canStart: false, startBlockers: ['not-host'] }))).toBe('Waiting for Cy to ready up');
    expect(statusLine(makeState([host({ isLocal: false }), readyMe], { role: 'client', canStart: false, startBlockers: ['not-host'] }))).toBe('Waiting for the host to start');
  });

  it('closed rooms say so', () => {
    expect(statusLine(makeState([host()], { phase: 'closed' }))).toBe('The room is closed');
  });
});

describe('fighter availability (taken animals)', () => {
  it('disables fighters held by OTHER humans, not your own and not bots', () => {
    const s = makeState(
      [host({ isLocal: false }), human('b', 'Bob', 'eagle', { isLocal: true }), human('c', 'Cy', 'hippo'), bot(1, 'rhino')],
      { role: 'client', mode: 'battleRoyale' },
    );
    const av = fighterAvailability(s);
    expect(av).toHaveLength(ANIMAL_IDS.length);
    const by = Object.fromEntries(av.map((a) => [a.animal, a]));
    expect(by.lion.taken).toBe(true);
    expect(by.lion.takenBy).toBe('Ann');
    expect(by.hippo.taken).toBe(true);
    expect(by.hippo.takenBy).toBe('Cy');
    expect(by.eagle.taken).toBe(false);
    expect(by.eagle.mine).toBe(true);
    expect(by.rhino.taken).toBe(false);
    expect(by.rhino.heldByBot).toBe(true);
    expect(by.mole.taken).toBe(false);
    expect(av.filter((a) => a.taken).map((a) => a.animal).sort()).toEqual(['hippo', 'lion']);
  });

  it('every animal is free in an empty lobby', () => {
    const av = fighterAvailability(makeState([]));
    expect(av.every((a) => !a.taken && !a.mine)).toBe(true);
  });
});

describe('room view', () => {
  it('builds cards with host / you flags, ready state, ping and kick rights', () => {
    const s = makeState([host(), human('b', 'Bob', 'eagle', { ready: true, pingMs: 45 }), human('c', 'Cy', 'hippo', { pingMs: 0 })]);
    const vm = buildRoomView(s);
    expect(vm.isHost).toBe(true);
    expect(vm.humans.map((c) => c.name)).toEqual(['Ann', 'Bob', 'Cy']);
    const [ann, bob, cy] = vm.humans;
    expect(ann.isHost && ann.isLocal && ann.ready).toBe(true);
    expect(ann.canKick).toBe(false); // never yourself
    expect(bob.canKick).toBe(true);
    expect(bob.ready).toBe(true);
    expect(bob.ping.text).toBe('45 ms');
    expect(bob.ping.bars).toBe(4);
    expect(cy.ready).toBe(false);
    expect(cy.ping.quality).toBe('unknown'); // not measured yet
    expect(ann.ping.quality).toBe('unknown'); // the host has no ping to itself
    expect(vm.emptySlots).toBe(ROOM_LIMITS.maxHumans - 3);
    expect(vm.local?.name).toBe('Ann');
    expect(vm.locked).toBe(false);
    expect(vm.modeLabel).toBe('Champions League');
    expect(vm.constraint).toMatch(/no bots/i);
  });

  it('clients never get kick rights, and nothing is editable while starting', () => {
    const s = makeState([host({ isLocal: false }), human('b', 'Bob', 'eagle', { isLocal: true })], { role: 'client' });
    expect(buildRoomView(s).humans.every((c) => !c.canKick)).toBe(true);
    const starting = buildRoomView(makeState([host(), human('b', 'Bob', 'eagle', { ready: true })], { phase: 'starting' }));
    expect(starting.locked).toBe(true);
    expect(starting.humans.every((c) => !c.canKick)).toBe(true);
  });

  it('Battle Royale: bots are listed separately, removable by the host, and the counts include auto-fill', () => {
    const s = makeState([host(), human('b', 'Bob', 'eagle'), bot(1, 'rhino'), bot(2, 'mole')], { mode: 'battleRoyale', botFill: 6 });
    const vm = buildRoomView(s);
    expect(vm.humans).toHaveLength(2);
    expect(vm.bots.map((b) => b.id)).toEqual(['bot:1', 'bot:2']);
    expect(vm.bots.every((b) => b.canRemoveBot)).toBe(true);
    expect(vm.counts).toEqual({ humans: 2, bots: 2, fill: 6, total: 10 });
    expect(vm.constraint).toMatch(/up to 10/);
    const asClient = buildRoomView({ ...s, role: 'client' });
    expect(asClient.bots.every((b) => !b.canRemoveBot)).toBe(true);
  });

  it('Champions League ignores bot fill in the counts', () => {
    const s = makeState([host(), human('b', 'Bob', 'eagle')], { mode: 'championsLeague', botFill: 8 });
    expect(rosterCounts(s)).toEqual({ humans: 2, bots: 0, fill: 0, total: 2 });
  });

  it('fills the up-to-four human places with empty slots', () => {
    expect(buildRoomView(makeState([host()])).emptySlots).toBe(3);
    const full = makeState([host(), human('b', 'B', 'eagle'), human('c', 'C', 'hippo'), human('d', 'D', 'rhino')]);
    expect(buildRoomView(full).emptySlots).toBe(0);
  });
});

describe('settings key', () => {
  it('changes with anything the rules panel shows, and not with pings or ready flags', () => {
    const base = makeState([host(), human('b', 'Bob', 'eagle')]);
    const k = settingsKey(base);
    expect(settingsKey({ ...base, slots: base.slots.map((s) => ({ ...s, pingMs: 99, ready: true })) })).toBe(k);
    expect(settingsKey({ ...base, mode: 'battleRoyale' })).not.toBe(k);
    expect(settingsKey({ ...base, settings: { ...base.settings, cl: { ...base.settings.cl, stocks: 5 } } })).not.toBe(k);
    expect(settingsKey({ ...base, settings: { ...base.settings, cl: { ...base.settings.cl, stage: 'skyAqueduct' } } })).not.toBe(k);
    expect(settingsKey({ ...base, settings: { ...base.settings, br: { ...base.settings.br, botLevel: 4 } } })).not.toBe(k);
    expect(settingsKey({ ...base, phase: 'starting' })).not.toBe(k);
    expect(settingsKey({ ...base, slots: [...base.slots, bot(1, 'rhino')] })).not.toBe(k);
  });
});
