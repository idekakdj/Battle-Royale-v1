import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings } from '../../src/ui/storage';

describe('FPS counter setting (v1.3.1)', () => {
  it('is off by default', () => {
    expect(DEFAULT_SETTINGS.showFps).toBe(false);
  });

  it('loadSettings falls back to the defaults (FPS counter off) when storage is unavailable', () => {
    // Node has no `window.localStorage`; storage.ts must degrade to defaults, never throw.
    expect(loadSettings().showFps).toBe(false);
  });
});
