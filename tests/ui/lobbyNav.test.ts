import { describe, expect, it } from 'vitest';
import { lobbyNavEntries, resolveNavClick } from '../../src/ui/lobbyNav';

describe('lobby nav entries (v1.5.1: PLAY / ONLINE / SETTINGS only)', () => {
  it('is exactly Play, Online, Settings when the online handler is wired', () => {
    const entries = lobbyNavEntries(true);
    expect(entries.map((e) => e.label)).toEqual(['Play', 'Online', 'Settings']);
    expect(entries.map((e) => e.id)).toEqual(['play', 'online', 'settings']);
  });

  it('hides Online when there is no online handler', () => {
    expect(lobbyNavEntries(false).map((e) => e.label)).toEqual(['Play', 'Settings']);
  });

  it('no longer offers Champions League or Gladiators', () => {
    for (const hasOnline of [true, false]) {
      const labels = lobbyNavEntries(hasOnline).map((e) => e.label.toLowerCase());
      expect(labels).not.toContain('champions league');
      expect(labels).not.toContain('gladiators');
    }
  });
});

describe('lobby nav clicks', () => {
  it('PLAY on the home view opens the mode select (same as the gold PLAY button)', () => {
    expect(resolveNavClick('play', 'play')).toEqual({ type: 'openModes' });
  });

  it('PLAY while Settings is open returns to the home view', () => {
    expect(resolveNavClick('play', 'settings')).toEqual({ type: 'show', view: 'play' });
  });

  it('SETTINGS always shows the settings panel (never a dead button)', () => {
    expect(resolveNavClick('settings', 'play')).toEqual({ type: 'show', view: 'settings' });
    expect(resolveNavClick('settings', 'settings')).toEqual({ type: 'show', view: 'settings' });
  });

  it('ONLINE opens the Online screen from either view', () => {
    expect(resolveNavClick('online', 'play')).toEqual({ type: 'openOnline' });
    expect(resolveNavClick('online', 'settings')).toEqual({ type: 'openOnline' });
  });
});
