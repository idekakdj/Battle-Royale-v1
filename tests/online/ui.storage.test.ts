import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ONLINE_MODE,
  ONLINE_ANIMAL_KEY,
  ONLINE_MODE_KEY,
  ONLINE_NAME_KEY,
  ONLINE_NAME_MAX,
  loadOnlineAnimal,
  loadOnlineMode,
  loadOnlineName,
  parseOnlineMode,
  parseOnlineName,
  saveOnlineAnimal,
  saveOnlineMode,
  saveOnlineName,
} from '../../src/ui/storage';

class FakeStorage {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.has(k) ? (this.data.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}

const g = globalThis as unknown as { window?: unknown };
const original = g.window;

function install(storage: unknown): FakeStorage | null {
  g.window = { localStorage: storage };
  return storage instanceof FakeStorage ? storage : null;
}

afterEach(() => {
  g.window = original;
});

describe('online name parsing', () => {
  it('trims, collapses whitespace, drops control characters and caps the length', () => {
    expect(parseOnlineName('  Ann  ')).toBe('Ann');
    expect(parseOnlineName('Ann   the\tGreat')).toBe('Ann the Great');
    expect(parseOnlineName('A\u0000n\u0007n')).toBe('A n n');
    expect(parseOnlineName('x'.repeat(40))).toHaveLength(ONLINE_NAME_MAX);
    // cut at 16 characters, then trimmed again (no trailing space)
    expect(parseOnlineName('  ' + 'y'.repeat(15) + '  z')).toBe('y'.repeat(15));
  });

  it('counts characters, not UTF-16 units', () => {
    const name = parseOnlineName('\u{1F981}'.repeat(20));
    expect(Array.from(name)).toHaveLength(ONLINE_NAME_MAX);
  });

  it('is empty for non-strings and blanks', () => {
    for (const v of [null, undefined, 42, {}, [], '', '   ', '\n\t']) expect(parseOnlineName(v), String(v)).toBe('');
  });
});

describe('online mode parsing', () => {
  it('accepts the two modes and defaults everything else', () => {
    expect(parseOnlineMode('battleRoyale')).toBe('battleRoyale');
    expect(parseOnlineMode('championsLeague')).toBe('championsLeague');
    for (const v of [null, undefined, '', 'br', 'BattleRoyale', 3, {}]) expect(parseOnlineMode(v), String(v)).toBe(DEFAULT_ONLINE_MODE);
  });
});

describe('online storage round trip', () => {
  it('saves and loads the name, mode and fighter', () => {
    const s = install(new FakeStorage()) as FakeStorage;
    expect(loadOnlineName()).toBe('');
    expect(loadOnlineMode()).toBe(DEFAULT_ONLINE_MODE);
    saveOnlineName('  Ann  ');
    saveOnlineMode('battleRoyale');
    saveOnlineAnimal('eagle');
    expect(s.data.get(ONLINE_NAME_KEY)).toBe('Ann');
    expect(s.data.get(ONLINE_MODE_KEY)).toBe('battleRoyale');
    expect(s.data.get(ONLINE_ANIMAL_KEY)).toBe('eagle');
    expect(loadOnlineName()).toBe('Ann');
    expect(loadOnlineMode()).toBe('battleRoyale');
    expect(loadOnlineAnimal()).toBe('eagle');
  });

  it('survives corrupt values', () => {
    const s = install(new FakeStorage()) as FakeStorage;
    s.setItem(ONLINE_NAME_KEY, '\u0000\u0001');
    s.setItem(ONLINE_MODE_KEY, '{"mode":1}');
    s.setItem(ONLINE_ANIMAL_KEY, 'dragon');
    expect(loadOnlineName()).toBe('');
    expect(loadOnlineMode()).toBe(DEFAULT_ONLINE_MODE);
    // an invalid online fighter falls back to the lobby fighter (gk-animal), which itself defaults to the lion
    expect(loadOnlineAnimal()).toBe('lion');
    s.setItem('gk-animal', 'rhino');
    expect(loadOnlineAnimal()).toBe('rhino');
  });

  it('never throws when storage is missing or blocked', () => {
    g.window = undefined;
    expect(loadOnlineName()).toBe('');
    expect(() => saveOnlineName('Ann')).not.toThrow();
    install({
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    });
    expect(loadOnlineName()).toBe('');
    expect(loadOnlineMode()).toBe(DEFAULT_ONLINE_MODE);
    expect(() => saveOnlineMode('battleRoyale')).not.toThrow();
    expect(() => saveOnlineAnimal('lion')).not.toThrow();
  });
});
