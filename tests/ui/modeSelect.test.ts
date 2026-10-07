import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODE_INFO, ModeSelect, nextModeFocus } from '../../src/ui/ModeSelect';
import { DEFAULT_MODE, GAME_MODES, MODE_KEY, loadMode, parseMode, saveMode, type GameMode } from '../../src/ui/storage';
import { BRAWL_OPPONENT_OPTIONS } from '../../src/brawl/ui/setup';
import { STAGE_IDS } from '../../src/brawl/types';
import { FakeDocument, FakeElement } from './fakeDom';

/** A fake `window.localStorage` backed by a Map. */
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

describe('gk-mode storage', () => {
  it('parseMode validates and falls back to Battle Royale', () => {
    expect(parseMode('battleRoyale')).toBe('battleRoyale');
    expect(parseMode('championsLeague')).toBe('championsLeague');
    for (const bad of [null, undefined, '', 'brawl', 'BattleRoyale', 'championsleague', 3, {}, ['battleRoyale']]) {
      expect(parseMode(bad)).toBe(DEFAULT_MODE);
    }
    expect(DEFAULT_MODE).toBe('battleRoyale');
  });

  it('loadMode returns the default when storage is unavailable (Node has no window)', () => {
    expect(loadMode()).toBe('battleRoyale');
    expect(() => saveMode('championsLeague')).not.toThrow();
  });

  it('loadMode survives a throwing / blocked localStorage', () => {
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
    expect(loadMode()).toBe('battleRoyale');
    expect(() => saveMode('championsLeague')).not.toThrow();
  });

  it('round-trips through the gk-mode key', () => {
    const store = stubStorage();
    expect(loadMode()).toBe('battleRoyale');
    saveMode('championsLeague');
    expect(store.get(MODE_KEY)).toBe('championsLeague');
    expect(MODE_KEY).toBe('gk-mode');
    expect(loadMode()).toBe('championsLeague');
  });

  it('falls back to the default when the stored value is corrupt', () => {
    stubStorage({ [MODE_KEY]: '{"mode":"x"}' });
    expect(loadMode()).toBe('battleRoyale');
    stubStorage({ [MODE_KEY]: 'championsLeague ' });
    expect(loadMode()).toBe('battleRoyale');
  });
});

describe('mode card content', () => {
  it('has one card per mode with the agreed copy', () => {
    expect(GAME_MODES).toEqual(['battleRoyale', 'championsLeague']);
    expect(MODE_INFO.battleRoyale.name).toBe('Battle Royale');
    expect(MODE_INFO.battleRoyale.blurb).toBe('10 gladiators, one winner. Fight through the colosseum or the jungle against bots on four difficulty levels.');
    expect(MODE_INFO.battleRoyale.tags).toEqual(['Free-for-all', '3D arena', 'Ultimates']);
    expect(MODE_INFO.championsLeague.name).toBe('Champions League');
    expect(MODE_INFO.championsLeague.blurb).toBe("Platform fighter. Build up rivals' damage and launch them off the stage.");
  });

  it('derives the Champions League tags from the real setup options', () => {
    const tags = MODE_INFO.championsLeague.tags;
    expect(tags[0]).toBe(`${Math.min(...BRAWL_OPPONENT_OPTIONS)}–${Math.max(...BRAWL_OPPONENT_OPTIONS)} bots`);
    expect(tags).toContain('Stocks');
    expect(tags).toContain(`${STAGE_IDS.length} maps`);
  });
});

describe('nextModeFocus (keyboard model)', () => {
  it('left / right cycle through the cards', () => {
    expect(nextModeFocus('battleRoyale', 'ArrowRight', 'battleRoyale')).toBe('championsLeague');
    expect(nextModeFocus('championsLeague', 'ArrowLeft', 'championsLeague')).toBe('battleRoyale');
    // wraps
    expect(nextModeFocus('championsLeague', 'ArrowRight', 'championsLeague')).toBe('battleRoyale');
    expect(nextModeFocus('battleRoyale', 'ArrowLeft', 'battleRoyale')).toBe('championsLeague');
  });

  it('down goes to Back; up / left / right return to the last card', () => {
    expect(nextModeFocus('battleRoyale', 'ArrowDown', 'battleRoyale')).toBe('back');
    expect(nextModeFocus('back', 'ArrowUp', 'championsLeague')).toBe('championsLeague');
    expect(nextModeFocus('back', 'ArrowLeft', 'battleRoyale')).toBe('battleRoyale');
    expect(nextModeFocus('back', 'ArrowRight', 'battleRoyale')).toBe('battleRoyale');
    expect(nextModeFocus('back', 'ArrowDown', 'battleRoyale')).toBeNull();
  });

  it('ignores keys that do not move focus', () => {
    for (const key of ['Enter', 'Escape', 'Tab', ' ', 'a', 'ArrowUp']) {
      expect(nextModeFocus('battleRoyale', key, 'battleRoyale')).toBeNull();
    }
  });
});

describe('ModeSelect screen', () => {
  let doc: FakeDocument;
  let host: FakeElement;
  let selected: GameMode[];
  let backs: number;

  beforeEach(() => {
    doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    host = doc.createElement('div');
    selected = [];
    backs = 0;
  });

  const mount = (initialMode?: GameMode): ModeSelect => {
    const s = new ModeSelect({
      initialMode,
      onSelect: (m) => selected.push(m),
      onBack: () => {
        backs++;
      },
    });
    s.mount(host as unknown as HTMLElement);
    return s;
  };
  const card = (mode: GameMode): FakeElement => {
    const found = host.find((e) => e.dataset.mode === mode);
    expect(found).toHaveLength(1);
    return found[0];
  };
  const focusedMode = (): string | undefined =>
    host.find((e) => e.classList.contains('gk-ms__card') && e.classList.contains('is-focused'))[0]?.dataset.mode;

  it('mounts the root, two cards in order, the title and a Back button', () => {
    mount('battleRoyale');
    const root = host.children[0];
    expect(root.className).toContain('gk-ms');
    expect(host.find((e) => e.className === 'gk-ms__title gk-display')[0].textContent).toBe('Choose Your Mode');
    const cards = host.find((e) => e.classList.contains('gk-ms__card'));
    expect(cards.map((c) => c.dataset.mode)).toEqual(['battleRoyale', 'championsLeague']);
    expect(host.find((e) => e.classList.contains('gk-ms__back'))).toHaveLength(1);
  });

  it('pre-focuses the remembered mode (the stored gk-mode when no initialMode is passed)', () => {
    stubStorage({ [MODE_KEY]: 'championsLeague' });
    mount();
    expect(doc.activeElement).toBe(card('championsLeague'));
    expect(focusedMode()).toBe('championsLeague');
  });

  it('pre-focuses Battle Royale on a first run or a bad stored value', () => {
    stubStorage({ [MODE_KEY]: 'nonsense' });
    mount();
    expect(doc.activeElement).toBe(card('battleRoyale'));
    expect(focusedMode()).toBe('battleRoyale');
  });

  it('a click selects the mode, remembers it and fires the callback once (double click safe)', () => {
    const store = stubStorage();
    mount('battleRoyale');
    card('championsLeague').click();
    card('championsLeague').click();
    expect(selected).toEqual(['championsLeague']);
    expect(store.get(MODE_KEY)).toBe('championsLeague');
  });

  it('arrow keys move the highlight, Enter on the body selects the highlighted card', () => {
    const store = stubStorage();
    mount('battleRoyale');
    const right = doc.key('ArrowRight');
    expect(right.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(card('championsLeague'));
    expect(focusedMode()).toBe('championsLeague');
    doc.key('ArrowLeft');
    expect(focusedMode()).toBe('battleRoyale');
    doc.key('ArrowRight');
    // focus lost (e.g. the mouse clicked empty space): Enter still acts on the highlighted card
    doc.activeElement = null;
    doc.key('Enter', { target: doc.body });
    expect(selected).toEqual(['championsLeague']);
    expect(store.get(MODE_KEY)).toBe('championsLeague');
  });

  it('hovering a card highlights (focuses) it', () => {
    mount('battleRoyale');
    card('championsLeague').dispatch('mouseenter');
    expect(focusedMode()).toBe('championsLeague');
    expect(doc.activeElement).toBe(card('championsLeague'));
  });

  it('a held Enter (key repeat from the lobby PLAY button) never auto-selects', () => {
    mount('battleRoyale');
    doc.activeElement = null;
    const ev = doc.key('Enter', { target: doc.body, repeat: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(selected).toEqual([]);
  });

  it('Esc and the Back button both go back; down moves to Back and up returns', () => {
    mount('championsLeague');
    const esc = doc.key('Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(backs).toBe(1);
    const back = host.find((e) => e.classList.contains('gk-ms__back'))[0];
    back.click();
    expect(backs).toBe(2);
    doc.key('ArrowDown');
    expect(doc.activeElement).toBe(back);
    expect(focusedMode()).toBeUndefined(); // no card highlighted while Back has focus
    doc.key('ArrowUp');
    expect(doc.activeElement).toBe(card('championsLeague'));
    expect(focusedMode()).toBe('championsLeague');
  });

  it('modifier chords are ignored', () => {
    mount('battleRoyale');
    doc.key('Escape', { ctrlKey: true });
    doc.key('ArrowRight', { altKey: true });
    expect(backs).toBe(0);
    expect(doc.activeElement).toBe(card('battleRoyale'));
  });

  it('unmount removes the screen and the keyboard listener', () => {
    const s = mount('battleRoyale');
    expect(doc.listenerCount('keydown')).toBe(1);
    s.unmount();
    expect(doc.listenerCount('keydown')).toBe(0);
    expect(host.children).toHaveLength(0);
    doc.key('Escape');
    expect(backs).toBe(0);
  });
});
