import { describe, expect, it } from 'vitest';
import {
  buildInviteLink,
  collapseJoinInput,
  copyText,
  joinCodeFromSearch,
  joinNames,
  parseJoinInput,
  pingInfo,
  searchWithoutJoin,
  timeLimitLabel,
} from '../../src/online/ui/helpers';
import { isValidRoomCode } from '../../src/online/room/roomCode';

describe('parseJoinInput', () => {
  it('accepts the bare code in any case, with spaces and dashes', () => {
    for (const s of ['K7P4Q', 'k7p4q', ' k7p4q ', 'K7P 4Q', 'k7-p4-q', '  K 7 P 4 Q  ']) {
      expect(parseJoinInput(s), s).toEqual({ kind: 'ok', code: 'K7P4Q' });
    }
  });

  it('accepts a pasted invite link and a peer id', () => {
    expect(parseJoinInput('https://example.com/game/?join=k7p4q')).toEqual({ kind: 'ok', code: 'K7P4Q' });
    expect(parseJoinInput('http://localhost:5173/?signal=localhost:9000&join=ABCDE&netsim=latency:80')).toEqual({ kind: 'ok', code: 'ABCDE' });
    expect(parseJoinInput('?join=abcde')).toEqual({ kind: 'ok', code: 'ABCDE' });
    expect(parseJoinInput('gk1-ABCDE')).toEqual({ kind: 'ok', code: 'ABCDE' });
    expect(parseJoinInput('gk1-ABCDE-x7k2pq')).toEqual({ kind: 'ok', code: 'ABCDE' });
  });

  it('distinguishes empty from invalid', () => {
    expect(parseJoinInput('')).toEqual({ kind: 'empty' });
    expect(parseJoinInput('   ')).toEqual({ kind: 'empty' });
    for (const s of ['K7P4', 'K7P4QQ', 'ILO01', 'hello world', 'https://example.com/']) {
      expect(parseJoinInput(s), s).toEqual({ kind: 'invalid' });
    }
  });

  it('rejects look-alike characters (the code alphabet has no I, L, O, 0, 1)', () => {
    expect(parseJoinInput('A1B2C').kind).toBe('invalid');
    expect(parseJoinInput('AOB2C').kind).toBe('invalid');
  });
});

describe('collapseJoinInput', () => {
  it('turns anything recognisable into the canonical code and leaves the rest alone', () => {
    expect(collapseJoinInput('https://x.y/?join=k7p4q')).toBe('K7P4Q');
    expect(collapseJoinInput('k7p4q')).toBe('K7P4Q');
    expect(collapseJoinInput('k7p')).toBe('k7p');
    expect(collapseJoinInput('')).toBe('');
    expect(isValidRoomCode(collapseJoinInput('gk1-abcde-xxxxxx'))).toBe(true);
  });
});

describe('join links', () => {
  it('reads and strips the join parameter, keeping the others', () => {
    expect(joinCodeFromSearch('?join=k7p4q')).toBe('K7P4Q');
    expect(joinCodeFromSearch('?signal=localhost:9000&join=ABCDE')).toBe('ABCDE');
    expect(joinCodeFromSearch('?join=nope')).toBeNull();
    expect(joinCodeFromSearch('?brawl=1')).toBeNull();
    expect(joinCodeFromSearch('')).toBeNull();
    expect(searchWithoutJoin('?join=ABCDE')).toBe('');
    expect(searchWithoutJoin('?signal=localhost%3A9000&join=ABCDE&x=1')).toBe('?signal=localhost%3A9000&x=1');
    expect(searchWithoutJoin('?x=1')).toBe('?x=1');
  });

  it('builds <origin+pathname>?join=CODE for web pages', () => {
    expect(buildInviteLink('K7P4Q', { protocol: 'https:', origin: 'https://idekakdj.github.io', pathname: '/Battle-Royale-v1/' })).toBe(
      'https://idekakdj.github.io/Battle-Royale-v1/?join=K7P4Q',
    );
    expect(buildInviteLink('K7P4Q', { protocol: 'http:', origin: 'http://localhost:5173', pathname: '/', search: '?brawl=1' })).toBe('http://localhost:5173/?join=K7P4Q');
  });

  it('carries a local signalling server over so QA friends use the same one', () => {
    const link = buildInviteLink('K7P4Q', { protocol: 'http:', origin: 'http://192.168.2.15:5173', pathname: '/', search: '?signal=192.168.2.15:9000&netsim=latency:80' });
    expect(link).toBe('http://192.168.2.15:5173/?join=K7P4Q&signal=192.168.2.15%3A9000');
    expect(parseJoinInput(link ?? '')).toEqual({ kind: 'ok', code: 'K7P4Q' });
  });

  it('has no link in the desktop build (nothing a friend could open)', () => {
    expect(buildInviteLink('K7P4Q', { protocol: 'app:', origin: 'app://gladiator', pathname: '/index.html' })).toBeNull();
    expect(buildInviteLink('K7P4Q', { protocol: 'file:', origin: 'null', pathname: '/C:/game/index.html' })).toBeNull();
  });
});

describe('copyText', () => {
  it('resolves false (never throws) when no clipboard or DOM is available', async () => {
    await expect(copyText('K7P4Q')).resolves.toBe(false);
  });
});

describe('pingInfo', () => {
  it('maps round-trip times to bars and a quality class', () => {
    expect(pingInfo(0)).toEqual({ bars: 0, quality: 'unknown', text: '\u2013' });
    expect(pingInfo(Number.NaN).quality).toBe('unknown');
    expect(pingInfo(-5).quality).toBe('unknown');
    expect(pingInfo(20)).toEqual({ bars: 4, quality: 'great', text: '20 ms' });
    expect(pingInfo(80).bars).toBe(3);
    expect(pingInfo(150).bars).toBe(2);
    expect(pingInfo(250).bars).toBe(1);
    expect(pingInfo(900)).toEqual({ bars: 1, quality: 'bad', text: '900 ms' });
    expect(pingInfo(42.6).text).toBe('43 ms');
  });

  it('never gets better as the ping grows', () => {
    let last = 5;
    for (let ms = 1; ms < 1000; ms += 7) {
      const b = pingInfo(ms).bars;
      expect(b).toBeLessThanOrEqual(last);
      last = b;
    }
  });
});

describe('small formatters', () => {
  it('joinNames', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['Bob'])).toBe('Bob');
    expect(joinNames(['Bob', 'Cy'])).toBe('Bob and Cy');
    expect(joinNames(['Bob', 'Cy', 'Di'])).toBe('Bob, Cy and Di');
  });

  it('timeLimitLabel', () => {
    expect(timeLimitLabel(0)).toBe('None');
    expect(timeLimitLabel(180)).toBe('3 min');
    expect(timeLimitLabel(300)).toBe('5 min');
    expect(timeLimitLabel(90)).toBe('90 s');
    expect(timeLimitLabel(Number.NaN)).toBe('None');
  });
});
