import { describe, expect, it } from 'vitest';
import type { NetEndReason } from '../../src/online/types';
import type { RoomEndReason, RoomErrorCode, RoomVersions } from '../../src/online/room/types';
import { describeEndReason, describeMatchResult, describeRoomError, describeVersionMismatch } from '../../src/online/ui/errors';

/** Compile-time exhaustive: adding a code to the union fails this object literal until the test list is updated. */
const ALL_CODES: Record<RoomErrorCode, true> = {
  'bad-code': true,
  'no-such-room': true,
  'signalling-failed': true,
  'connect-failed': true,
  timeout: true,
  'version-mismatch': true,
  'room-full': true,
  'room-busy': true,
  kicked: true,
  'host-left': true,
  'not-host': true,
  'wrong-phase': true,
  'animal-taken': true,
  'cannot-start': true,
  'mesh-failed': true,
  protocol: true,
  internal: true,
};

const NET_REASONS: Record<NetEndReason, true> = {
  'host-left': true,
  'peer-left': true,
  desync: true,
  timeout: true,
  'version-mismatch': true,
  error: true,
};

const versions = (appVersion: string, protocol = 1, fp = 'abc'): RoomVersions => ({
  protocol,
  appVersion,
  fingerprints: { championsLeague: fp, battleRoyale: fp },
});

describe('describeRoomError', () => {
  it('has friendly text for every RoomErrorCode', () => {
    for (const code of Object.keys(ALL_CODES) as RoomErrorCode[]) {
      const t = describeRoomError({ code, message: 'raw message' });
      expect(t.title.length, code).toBeGreaterThan(3);
      expect(t.message.length, code).toBeGreaterThan(8);
      // user-facing text never leaks internal jargon / code names
      expect(t.title + t.message, code).not.toMatch(/undefined|\[object/);
    }
  });

  it('falls back sensibly for an unknown code and for a missing message', () => {
    const t = describeRoomError({ code: 'totally-new', message: 'boom' });
    expect(t.title).toBe('Something went wrong');
    expect(t.message).toBe('boom');
    expect(describeRoomError({ code: 'internal' }).message.length).toBeGreaterThan(8);
  });

  it('connect-failed and timeout mention firewall / TURN', () => {
    for (const code of ['connect-failed', 'timeout', 'mesh-failed'] as const) {
      const t = describeRoomError({ code });
      expect(`${t.message} ${t.hint ?? ''}`, code).toMatch(/firewall/i);
      expect(`${t.message} ${t.hint ?? ''}`, code).toMatch(/TURN/);
    }
  });

  it('no-such-room and bad-code tell the player what to check', () => {
    expect(describeRoomError({ code: 'no-such-room' }).hint).toMatch(/code/i);
    expect(describeRoomError({ code: 'bad-code' }).message).toMatch(/5/);
  });

  it('keeps the room layer message for wrong-phase / cannot-start / mesh-failed', () => {
    expect(describeRoomError({ code: 'wrong-phase', message: 'Bots are only available in Battle Royale.' }).message).toContain('Bots are only');
    expect(describeRoomError({ code: 'cannot-start', message: 'Bob left.' }).message).toBe('Bob left.');
    expect(describeRoomError({ code: 'mesh-failed', message: 'Ann could not link.' }).message).toBe('Ann could not link.');
  });
});

describe('version mismatch text', () => {
  it('says which version the host runs and which one you run', () => {
    const t = describeRoomError({ code: 'version-mismatch', message: 'x', details: { host: versions('1.5.0'), local: versions('1.4.1'), mismatch: ['appVersion'] } });
    expect(t.message).toBe('The host runs v1.5.0, you run v1.4.1.');
    expect(t.hint).toMatch(/same version/i);
  });

  it('names the protocol when only the protocol differs', () => {
    const t = describeVersionMismatch({ host: versions('1.5.0', 2), local: versions('1.5.0', 1), mismatch: ['protocol'] });
    expect(t.message).toMatch(/protocol 2/);
    expect(t.message).toMatch(/protocol 1/);
  });

  it('names the mode data when only a fingerprint differs', () => {
    const t = describeVersionMismatch({ host: versions('1.5.0', 1, 'aaa'), local: versions('1.5.0', 1, 'bbb'), mismatch: ['fingerprint:championsLeague'] });
    expect(t.message).toMatch(/Champions League data/);
    expect(t.message).toMatch(/1\.5\.0/);
  });

  it('degrades gracefully without details', () => {
    expect(describeVersionMismatch(undefined).message.length).toBeGreaterThan(10);
    expect(describeVersionMismatch(undefined, 'Custom text').message).toBe('Custom text');
  });
});

describe('describeEndReason / describeMatchResult', () => {
  it('has text for every NetEndReason, the room-only reasons and "finished"', () => {
    const reasons: Array<NetEndReason | RoomEndReason | 'finished'> = [...(Object.keys(NET_REASONS) as NetEndReason[]), 'kicked', 'left', 'finished'];
    for (const r of reasons) {
      const t = describeEndReason(r);
      expect(t.title.length, r).toBeGreaterThan(3);
      expect(t.message.length, r).toBeGreaterThan(5);
    }
  });

  it('prefers the message supplied by the room / match', () => {
    expect(describeEndReason('host-left', 'The host closed the room.').message).toBe('The host closed the room.');
    expect(describeEndReason('peer-left', '  Ann left the match  ').message).toBe('Ann left the match');
    expect(describeEndReason('error', '   ').message).toMatch(/error/i);
  });

  it('a normally finished match has no toast; a cut-short one explains itself', () => {
    expect(describeMatchResult({ reason: 'finished' })).toBeNull();
    expect(describeMatchResult({ reason: 'finished', message: 'You left the match.' })).toBeNull();
    expect(describeMatchResult({ reason: 'host-left', message: 'The host left the match.' })).toBe('The host left the match.');
    expect(describeMatchResult({ reason: 'timeout' })).toMatch(/Connection lost/);
    expect(describeMatchResult({ reason: 'desync' })).toMatch(/out of sync/);
  });
});
