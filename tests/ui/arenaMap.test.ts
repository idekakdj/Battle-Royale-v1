/**
 * v1.8 Battle Royale map choice: `gk-arena` storage, the Difficulty screen's map row (view logic + keyboard + the selectors the
 * packaged-app smoke test relies on) and the arena thumbnails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARENA_IDS, type ArenaId } from '../../src/core/types';
import { ARENAS } from '../../src/config/arenas';
import { ARENA_KEY, DEFAULT_ARENA, DIFFICULTY_KEY, loadArena, parseArena, saveArena } from '../../src/ui/storage';
import { DifficultySelect, mapChoices, mapKeyTarget, stepArena } from '../../src/ui/DifficultySelect';
import { arenaThumbSvg, mixHex } from '../../src/ui/mapThumb';
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
    expect(parseArena('ocean')).toBe('ocean'); // v1.9 Ocean Dome
    for (const bad of [null, undefined, '', 'Jungle', 'jungle ', 'Ocean', 'ocean ', 'sea', 'forest', 3, {}, ['jungle'], ['ocean'], true]) {
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

  it('the ocean round-trips and is remembered across screens (gk-arena = "ocean")', () => {
    const store = stubStorage();
    saveArena('ocean');
    expect(store.get(ARENA_KEY)).toBe('ocean');
    expect(loadArena()).toBe('ocean');
    stubStorage({ [ARENA_KEY]: '"ocean"' }); // JSON-quoted junk is not an id
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
    expect(choices.map((c) => c.name)).toEqual(['Colosseum', 'Jungle Clearing', 'Ocean Dome']);
  });

  it('stepArena wraps and tolerates an unknown id', () => {
    expect(stepArena('colosseum', 1)).toBe('jungle');
    expect(stepArena('jungle', 1)).toBe('ocean');
    expect(stepArena('ocean', 1)).toBe('colosseum');
    expect(stepArena('colosseum', -1)).toBe('ocean');
    expect(stepArena('jungle', -1)).toBe('colosseum');
    expect(stepArena('ocean', -1)).toBe('jungle');
    expect(stepArena('jungle', 2)).toBe('colosseum');
    expect(stepArena('colosseum', 3)).toBe('colosseum');
    expect(stepArena('nope' as never, 1)).toBe('jungle');
  });

  it('arrow keys act only with a map card focused; M cycles from anywhere; others are ignored', () => {
    expect(mapKeyTarget('colosseum', 'ArrowRight', true)).toBe('jungle');
    expect(mapKeyTarget('colosseum', 'ArrowDown', true)).toBe('jungle');
    expect(mapKeyTarget('jungle', 'ArrowLeft', true)).toBe('colosseum');
    expect(mapKeyTarget('jungle', 'ArrowUp', true)).toBe('colosseum');
    expect(mapKeyTarget('jungle', 'Home', true)).toBe('colosseum');
    expect(mapKeyTarget('colosseum', 'End', true)).toBe('ocean');
    expect(mapKeyTarget('colosseum', 'ArrowRight', false)).toBeNull();
    expect(mapKeyTarget('colosseum', 'm', false)).toBe('jungle');
    expect(mapKeyTarget('jungle', 'M', false)).toBe('ocean');
    expect(mapKeyTarget('ocean', 'M', false)).toBe('colosseum');
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

  const mount = (opts: { initialArena?: ArenaId; initialDifficulty?: 1 | 2 | 3 | 4 } = {}): DifficultySelect => {
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
    expect(cls('gk-ds__map')).toHaveLength(3);
    // the map cards must NOT match `.gk-ds__card` (the smoke test clicks the first one)
    expect(cls('gk-ds__card').every((c) => c.dataset.tier !== undefined && c.dataset.arena === undefined)).toBe(true);
    expect(cls('gk-ds__map').map((c) => c.dataset.arena)).toEqual(['colosseum', 'jungle', 'ocean']);
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

  it('the third card is the Ocean Dome: its name + blurb come from the ArenaDef, clicking it selects it and START persists "ocean"', () => {
    const store = stubStorage();
    mount({ initialDifficulty: 4 });
    const card = mapCard('ocean');
    expect(card.find((e) => e.classList.contains('gk-ds__mapname'))[0].textContent).toBe(ARENAS.ocean.name);
    expect(card.find((e) => e.classList.contains('gk-ds__mapblurb'))[0].textContent).toBe(ARENAS.ocean.blurb);
    expect(card.find((e) => e.classList.contains('gk-ds__mapart'))[0].innerHTML).toBe(arenaThumbSvg(ARENAS.ocean, 'gk-ds__mapsvg'));
    card.click();
    expect(selectedMap()).toBe('ocean');
    expect(card.attributes.get('aria-checked')).toBe('true');
    expect(card.tabIndex).toBe(0);
    cls('gk-ds__start')[0].click();
    expect(started).toEqual([[4, 'ocean']]);
    expect(store.get(ARENA_KEY)).toBe('ocean');
  });

  it('a stored "ocean" pre-selects the third card (the map is remembered, e.g. for REMATCH / the next visit)', () => {
    stubStorage({ [ARENA_KEY]: 'ocean' });
    const s = mount();
    expect(selectedMap()).toBe('ocean');
    expect(s.choice.arena).toBe('ocean');
    cls('gk-ds__start')[0].click();
    expect(started[0][1]).toBe('ocean');
  });

  it('keyboard over three cards: Home / End jump, arrows wrap, M cycles colosseum -> jungle -> ocean -> colosseum', () => {
    stubStorage();
    const s = mount();
    for (const expected of ['jungle', 'ocean', 'colosseum']) {
      doc.key('M');
      expect(selectedMap()).toBe(expected);
    }
    mapCard('colosseum').focus();
    doc.key('End');
    expect(selectedMap()).toBe('ocean');
    expect(doc.activeElement).toBe(mapCard('ocean'));
    doc.key('ArrowRight'); // wraps to the first
    expect(selectedMap()).toBe('colosseum');
    doc.key('ArrowLeft'); // wraps back to the last
    expect(selectedMap()).toBe('ocean');
    doc.key('Home');
    expect(selectedMap()).toBe('colosseum');
    expect(s.choice.arena).toBe('colosseum');
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
    expect(selectedMap()).toBe('ocean');
    doc.key('M'); // wraps
    expect(selectedMap()).toBe('colosseum');
    // arrows do nothing while focus is not on a map card
    expect(doc.key('ArrowRight').defaultPrevented).toBe(false);
    expect(selectedMap()).toBe('colosseum');
    mapCard('colosseum').focus();
    const ev = doc.key('ArrowRight');
    expect(ev.defaultPrevented).toBe(true);
    expect(selectedMap()).toBe('jungle');
    expect(doc.activeElement).toBe(mapCard('jungle'));
    doc.key('ArrowRight');
    expect(selectedMap()).toBe('ocean');
    expect(doc.activeElement).toBe(mapCard('ocean'));
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

  it('the ocean thumbnail shows the dome: both raised levels, all 9 ramps, the pads, coral + rock cover and the faint serpent strip', () => {
    const o = ARENAS.ocean;
    const svg = arenaThumbSvg(o);
    expect(svg).toContain('aria-hidden="true"');
    expect(o.heightfield?.filter((p) => p.kind === 'ramp')).toHaveLength(9);
    // 9 ramps = 9 rotated groups; the terrace is an annulus path (evenodd), the plateau a circle
    expect((svg.match(/<g transform="translate\(/g) ?? []).length).toBe(9);
    expect((svg.match(/fill-rule="evenodd"/g) ?? []).length).toBe(1);
    expect(svg).toContain('data-hint="serpent"');
    // each ramp is stepped from its low end's shade to its high end's: four slices + the outline
    expect((svg.match(/<rect /g) ?? []).length).toBe(9 * 5 + o.crates.length + 1); // + the serpent strip
    // every pad, plus ring + ground + plateau + every round blocker (coral / rock) — circles
    expect((svg.match(/<circle /g) ?? []).length).toBe(2 + 1 + o.pickupPads.length + o.circles.length);
    expect(svg).toContain('#ff7a9a'); // coral pillars
    expect(svg).toContain('#8a98a6'); // rock outcrops
    // the other arenas keep their pictures: no ramps, no serpent hint
    for (const id of ['colosseum', 'jungle'] as const) {
      const t = arenaThumbSvg(ARENAS[id]);
      expect(t).not.toContain('data-hint');
      expect(t).not.toContain('<g transform');
      expect(t).not.toContain('evenodd');
    }
    expect(svg).not.toBe(arenaThumbSvg(ARENAS.jungle));
  });

  it('the ocean thumbnail is deterministic and fits the same square as the other maps (viewBox = 2 x (wall + 2))', () => {
    expect(arenaThumbSvg(ARENAS.ocean)).toBe(arenaThumbSvg(ARENAS.ocean));
    for (const id of ARENA_IDS) {
      const a = ARENAS[id];
      const half = a.wallRadius + 2;
      expect(arenaThumbSvg(a)).toContain(`viewBox="${-half} ${-half} ${half * 2} ${half * 2}"`);
    }
  });

  it('mixHex blends and clamps', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#102030', '#102030', 0.7)).toBe('#102030');
    expect(mixHex('#000000', '#ffffff', -3)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 9)).toBe('#ffffff');
  });

  it('the colosseum has no terrain zones and draws its dais; both are valid, distinct pictures', () => {
    const c = arenaThumbSvg(ARENAS.colosseum);
    expect(c).toContain('stroke-dasharray');
    expect(c).not.toBe(arenaThumbSvg(ARENAS.jungle));
    for (const id of ARENA_IDS) expect(arenaThumbSvg(ARENAS[id], 'x')).toContain('class="x"');
  });
});
