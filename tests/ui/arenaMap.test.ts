/**
 * v1.8 Battle Royale map choice: `gk-arena` storage, the Difficulty screen's map row (view logic + keyboard + the selectors the
 * packaged-app smoke test relies on) and the arena thumbnails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARENA_IDS } from '../../src/core/types';
import { ARENAS } from '../../src/config/arenas';
import { ARENA_KEY, DEFAULT_ARENA, DIFFICULTY_KEY, loadArena, parseArena, saveArena } from '../../src/ui/storage';
import { DifficultySelect, mapChoices, mapKeyTarget, stepArena } from '../../src/ui/DifficultySelect';
import { arenaThumbSvg } from '../../src/ui/mapThumb';
import { FakeDocument, FakeElement } from './fakeDom';

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gk-arena storage', () => {
  it('parseArena validates and falls back to the colosseum', () => {
    expect(parseArena('colosseum')).toBe('colosseum');
    expect(parseArena('jungle')).toBe('jungle');
    for (const bad of [null, undefined, '', 'Jungle', 'jungle ', 'forest', 3, {}, ['jungle'], true]) {
      expect(parseArena(bad)).toBe('colosseum');
    }
    expect(DEFAULT_ARENA).toBe('colosseum');
    expect(ARENA_KEY).toBe('gk-arena');
  });

  it('loadArena / saveArena never throw without storage (Node has no window)', () => {
    expect(loadArena()).toBe('colosseum');
    expect(() => saveArena('jungle')).not.toThrow();
  });

  it('survives a blocked localStorage', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(loadArena()).toBe('colosseum');
    expect(() => saveArena('jungle')).not.toThrow();
  });

  it('round-trips through the gk-arena key; a bad stored value reads as the colosseum', () => {
    const store = stubStorage();
    expect(loadArena()).toBe('colosseum');
    saveArena('jungle');
    expect(store.get(ARENA_KEY)).toBe('jungle');
    expect(loadArena()).toBe('jungle');
    stubStorage({ [ARENA_KEY]: '{"arena":"jungle"}' });
    expect(loadArena()).toBe('colosseum');
    stubStorage({ [ARENA_KEY]: 'swamp' });
    expect(loadArena()).toBe('colosseum');
  });

  it('saveArena refuses to store garbage (an unknown id is written as the colosseum)', () => {
    const store = stubStorage();
    saveArena('lava' as never);
    expect(store.get(ARENA_KEY)).toBe('colosseum');
  });
});

describe('map choices + keyboard model', () => {
  it('has one card per arena in registry order, copy straight from the ArenaDef', () => {
    const choices = mapChoices();
    expect(choices.map((c) => c.id)).toEqual([...ARENA_IDS]);
    expect(choices[0].id).toBe('colosseum');
    for (const c of choices) {
      expect(c.name).toBe(ARENAS[c.id].name);
      expect(c.blurb).toBe(ARENAS[c.id].blurb);
      expect(c.blurb.length).toBeGreaterThan(10);
    }
    expect(choices.map((c) => c.name)).toEqual(['Colosseum', 'Jungle Clearing']);
  });

  it('stepArena wraps and tolerates an unknown id', () => {
    expect(stepArena('colosseum', 1)).toBe('jungle');
    expect(stepArena('jungle', 1)).toBe('colosseum');
    expect(stepArena('colosseum', -1)).toBe('jungle');
    expect(stepArena('jungle', -1)).toBe('colosseum');
    expect(stepArena('jungle', 2)).toBe('jungle');
    expect(stepArena('nope' as never, 1)).toBe('jungle');
  });

  it('arrow keys act only with a map card focused; M cycles from anywhere; others are ignored', () => {
    expect(mapKeyTarget('colosseum', 'ArrowRight', true)).toBe('jungle');
    expect(mapKeyTarget('colosseum', 'ArrowDown', true)).toBe('jungle');
    expect(mapKeyTarget('jungle', 'ArrowLeft', true)).toBe('colosseum');
    expect(mapKeyTarget('jungle', 'ArrowUp', true)).toBe('colosseum');
    expect(mapKeyTarget('jungle', 'Home', true)).toBe('colosseum');
    expect(mapKeyTarget('colosseum', 'End', true)).toBe('jungle');
    expect(mapKeyTarget('colosseum', 'ArrowRight', false)).toBeNull();
    expect(mapKeyTarget('colosseum', 'm', false)).toBe('jungle');
    expect(mapKeyTarget('jungle', 'M', false)).toBe('colosseum');
    for (const key of ['Enter', 'Escape', 'Tab', ' ', 'a', '1']) expect(mapKeyTarget('colosseum', key, true)).toBeNull();
  });
});

describe('DifficultySelect screen (difficulty + map)', () => {
  let doc: FakeDocument;
  let host: FakeElement;
  let started: Array<[number, string]>;

  beforeEach(() => {
    doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    host = doc.createElement('div');
    started = [];
  });

  const mount = (opts: { initialArena?: 'colosseum' | 'jungle'; initialDifficulty?: 1 | 2 | 3 | 4 } = {}): DifficultySelect => {
    const s = new DifficultySelect({ ...opts, onStart: (d, a) => started.push([d, a]), onBack: () => undefined });
    s.mount(host as unknown as HTMLElement);
    return s;
  };
  const cls = (name: string): FakeElement[] => host.find((e) => e.classList.contains(name));
  const mapCard = (id: string): FakeElement => host.find((e) => e.dataset.arena === id)[0];
  const selectedMap = (): string | undefined => cls('gk-ds__map').find((c) => c.classList.contains('is-selected'))?.dataset.arena;

  it('keeps the smoke-test selectors: 4 difficulty cards (.gk-ds__card) and one .gk-ds__start; map cards use their own class', () => {
    stubStorage();
    mount();
    expect(cls('gk-ds__card')).toHaveLength(4);
    expect(cls('gk-ds__start')).toHaveLength(1);
    expect(cls('gk-ds__map')).toHaveLength(2);
    // the map cards must NOT match `.gk-ds__card` (the smoke test clicks the first one)
    expect(cls('gk-ds__card').every((c) => c.dataset.tier !== undefined && c.dataset.arena === undefined)).toBe(true);
    expect(cls('gk-ds__map').map((c) => c.dataset.arena)).toEqual(['colosseum', 'jungle']);
    expect(cls('gk-ds__maps')[0].attributes.get('role')).toBe('radiogroup');
  });

  it('pre-selects the stored map (default colosseum) and exposes it via aria-checked + a roving tabindex', () => {
    stubStorage();
    mount();
    expect(selectedMap()).toBe('colosseum');
    stubStorage({ [ARENA_KEY]: 'jungle' });
    host = doc.createElement('div');
    mount();
    expect(selectedMap()).toBe('jungle');
    expect(mapCard('jungle').attributes.get('aria-checked')).toBe('true');
    expect(mapCard('colosseum').attributes.get('aria-checked')).toBe('false');
    expect(mapCard('jungle').tabIndex).toBe(0);
    expect(mapCard('colosseum').tabIndex).toBe(-1);
  });

  it('a bad stored map falls back to the colosseum', () => {
    stubStorage({ [ARENA_KEY]: 'volcano' });
    mount();
    expect(selectedMap()).toBe('colosseum');
  });

  it('clicking a map card selects it; START persists both choices and reports (difficulty, arena)', () => {
    const store = stubStorage();
    mount({ initialDifficulty: 3 });
    mapCard('jungle').click();
    expect(selectedMap()).toBe('jungle');
    cls('gk-ds__start')[0].click();
    expect(started).toEqual([[3, 'jungle']]);
    expect(store.get(ARENA_KEY)).toBe('jungle');
    expect(store.get(DIFFICULTY_KEY)).toBe('3');
  });

  it('START with the default map reports the colosseum', () => {
    stubStorage();
    mount({ initialDifficulty: 2 });
    cls('gk-ds__start')[0].click();
    expect(started).toEqual([[2, 'colosseum']]);
  });

  it('the difficulty cards still select independently of the map', () => {
    stubStorage();
    mount({ initialDifficulty: 1, initialArena: 'jungle' });
    host.find((e) => e.dataset.tier === '4')[0].click();
    cls('gk-ds__start')[0].click();
    expect(started).toEqual([[4, 'jungle']]);
  });

  it('keyboard: M cycles the map anywhere; arrows move + focus the map card when one is focused', () => {
    stubStorage();
    const s = mount();
    expect(doc.key('m').defaultPrevented).toBe(true);
    expect(selectedMap()).toBe('jungle');
    expect(s.choice.arena).toBe('jungle');
    doc.key('M');
    expect(selectedMap()).toBe('colosseum');
    // arrows do nothing while focus is not on a map card
    expect(doc.key('ArrowRight').defaultPrevented).toBe(false);
    expect(selectedMap()).toBe('colosseum');
    mapCard('colosseum').focus();
    const ev = doc.key('ArrowRight');
    expect(ev.defaultPrevented).toBe(true);
    expect(selectedMap()).toBe('jungle');
    expect(doc.activeElement).toBe(mapCard('jungle'));
    doc.key('ArrowRight'); // wraps
    expect(selectedMap()).toBe('colosseum');
    expect(doc.activeElement).toBe(mapCard('colosseum'));
    // modified keys are left alone
    expect(doc.key('m', { ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it('unmount removes the key listener (no leak into the next screen)', () => {
    stubStorage();
    const s = mount();
    expect(doc.listenerCount('keydown')).toBe(1);
    s.unmount();
    expect(doc.listenerCount('keydown')).toBe(0);
    expect(() => doc.key('m')).not.toThrow();
  });
});

describe('arena thumbnails (drawn from the arena data)', () => {
  it('draws every tree / pillar, the pool and the moss patches of the jungle', () => {
    const svg = arenaThumbSvg(ARENAS.jungle);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('aria-hidden="true"');
    const j = ARENAS.jungle;
    // ring + ground + every pad + every tree + every terrain zone
    const circles = (svg.match(/<circle /g) ?? []).length;
    expect(circles).toBe(2 + j.circles.length + j.pickupPads.length + j.terrain.length);
    expect((svg.match(/<line /g) ?? []).length).toBe(j.segments.length);
    expect((svg.match(/<rect /g) ?? []).length).toBe(j.crates.length);
  });

  it('the colosseum has no terrain zones and draws its dais; both are valid, distinct pictures', () => {
    const c = arenaThumbSvg(ARENAS.colosseum);
    expect(c).toContain('stroke-dasharray');
    expect(c).not.toBe(arenaThumbSvg(ARENAS.jungle));
    for (const id of ARENA_IDS) expect(arenaThumbSvg(ARENAS[id], 'x')).toContain('class="x"');
  });
});
