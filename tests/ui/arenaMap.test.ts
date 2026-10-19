/**
 * v1.8 Battle Royale map choice: `gk-arena` storage, the Difficulty screen's map row (view logic + keyboard + the selectors the
 * packaged-app smoke test relies on) and the arena thumbnails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARENA_IDS, type ArenaId } from '../../src/core/types';
import { ARENAS, OCEAN_STACKS, OCEAN_UPPER_HEIGHT } from '../../src/config/arenas';
import { serpentLaneBins } from '../../src/config/serpentLanes';
import { ARENA_KEY, DEFAULT_ARENA, DIFFICULTY_KEY, loadArena, parseArena, saveArena } from '../../src/ui/storage';
import { DifficultySelect, mapChoices, mapKeyTarget, stepArena } from '../../src/ui/DifficultySelect';
import { UPPER_FROM_M, arenaThumbSvg, mixHex } from '../../src/ui/mapThumb';
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

  it('the ocean thumbnail shows the dome: every level, every ramp piece, the pads, coral + rock cover and both faint serpent strips', () => {
    const o = ARENAS.ocean;
    const svg = arenaThumbSvg(o);
    expect(svg).toContain('aria-hidden="true"');
    const hf = o.heightfield ?? [];
    const ramps = hf.filter((p) => p.kind === 'ramp').length;
    const flats = hf.filter((p) => p.kind === 'plateau').length; // the centre plateau + the upper towers
    expect(ramps).toBe(18); // 5 seabed->terrace, 3 terrace->plateau, 3 causeways + 2 chords (two pieces each)
    expect(flats).toBe(4); // the plateau + 3 towers
    expect(o.pickupPads).toHaveLength(9);
    // one rotated group per ramp piece; the terrace is an annulus path (evenodd), the plateau and the towers circles
    expect((svg.match(/<g transform="translate\(/g) ?? []).length).toBe(ramps);
    expect((svg.match(/fill-rule="evenodd"/g) ?? []).length).toBe(1);
    // two strike-strip hints (low + high), each a rotated group with its bar and chevron
    expect((svg.match(/data-hint="serpent"/g) ?? []).length).toBe(2);
    expect(svg).toContain('data-tier="low"');
    expect(svg).toContain('data-tier="high"');
    // each ramp is stepped from its low end's shade to its high end's: four slices + the outline
    expect((svg.match(/<rect /g) ?? []).length).toBe(ramps * 5 + o.crates.length + 2); // + the two serpent strips
    // every pad, plus ring + ground + plateau + towers + every round blocker (coral / rock) — circles
    expect((svg.match(/<circle /g) ?? []).length).toBe(2 + flats + o.pickupPads.length + o.circles.length);
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

  it('the upper towers get their own tone (>= 6 m), distinct from the plateau; the ramps that climb to them blend into it', () => {
    const o = ARENAS.ocean;
    expect(UPPER_FROM_M).toBeLessThanOrEqual(OCEAN_UPPER_HEIGHT);
    expect(UPPER_FROM_M).toBeGreaterThan(3); // the plateau is not "upper"
    const svg = arenaThumbSvg(o);
    const towers = svg.match(/<circle [^>]*data-tier="upper"[^>]*\/>/g) ?? [];
    expect(towers).toHaveLength(OCEAN_STACKS.length);
    const fills = new Set(towers.map((t) => /fill="(#[0-9a-f]{6})"/.exec(t)?.[1]));
    expect(fills.size).toBe(1); // all towers share the one tone
    const upperFill = [...fills][0] as string;
    // each tower is drawn at its real position and radius
    for (const st of OCEAN_STACKS) {
      expect(towers.some((t) => t.includes(`cx="${Math.round(st.x * 10) / 10}"`) && t.includes(`cy="${Math.round(st.z * 10) / 10}"`) && t.includes(`r="${st.radius}"`))).toBe(true);
    }
    // the plateau (3 m) is NOT in the tower tone, and no ordinary level is
    const plateau = (svg.match(/<circle cx="0" cy="0" r="8"[^>]*\/>/g) ?? [])[0] ?? '';
    expect(plateau).toContain('fill="#');
    expect(plateau).not.toContain(upperFill);
    expect(plateau).not.toContain('data-tier');
    const plateauFill = /fill="(#[0-9a-f]{6})"/.exec(plateau)?.[1] ?? '#000000';
    const rgb = (hex: string): number[] => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
    // the ramps that climb above the plateau blend from its shade toward the tower tone (redder, less green than the plateau)
    const ramps = svg.match(/<g transform="translate\([^>]*>.*?<\/g>/g) ?? [];
    expect(ramps).toHaveLength(18);
    const aboveThePlateau = ramps.filter((g) =>
      [...g.matchAll(/fill="(#[0-9a-f]{6})"/g)].some((m) => rgb(m[1])[0] > rgb(plateauFill)[0] + 2 && rgb(m[1])[1] < rgb(plateauFill)[1]),
    );
    expect(aboveThePlateau).toHaveLength(10); // 3 causeways + 2 chords, two pieces each
    // legible: the tower tone differs from the plateau shade and the cliff edge is darker than the fill
    expect(upperFill).not.toBe(plateauFill);
    expect(towers[0]).toMatch(/stroke="#3b1d73"/);
  });

  it('the serpent strip hints lie along lanes the serpents really use (low on a low bin, high over a tower)', () => {
    const o = ARENAS.ocean;
    const svg = arenaThumbSvg(o);
    const bins = serpentLaneBins(o);
    const angleOf = (tier: 'low' | 'high'): number => {
      const m = new RegExp(String.raw`<g transform="rotate\(([-\d.]+)\)" data-hint="serpent" data-tier="${tier}"`).exec(svg);
      expect(m, tier).not.toBeNull();
      return Number(m?.[1]);
    };
    const low = angleOf('low');
    const high = angleOf('high');
    expect(bins.low).toContain(Math.floor(low));
    expect(bins.high).toContain(Math.floor(high));
    expect(Math.abs(low - 305)).toBeLessThan(25); // still up-right, clear of the player's seat at the bottom
    expect(Math.abs(high - 180)).toBeLessThan(25); // points at the left-hand tower
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
