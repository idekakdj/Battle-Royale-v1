/**
 * Pause menu overlay (WP-F, BLUEPRINT §3/§12). NOT a Screen — the match
 * controller mounts it over the HUD when Esc pauses the sim (PvE, so pausing is
 * fair) and unmounts it on resume. Dim overlay with Resume / Settings (the
 * shared lobby {@link SettingsPanel}) / Quit to Lobby.
 */

import { el, button } from './dom';
import { SettingsPanel } from './SettingsPanel';
import type { GkSettings } from './storage';

export interface PauseMenuOptions {
  onResume: () => void;
  onQuitToLobby: () => void;
  /** Forwarded to the embedded settings panel. */
  onSettingsChange?: (settings: GkSettings) => void;
}

export class PauseMenu {
  private readonly opts: PauseMenuOptions;
  private root: HTMLElement | null = null;
  private menuEl: HTMLElement | null = null;
  private settingsEl: HTMLElement | null = null;
  private settingsPanel: SettingsPanel | null = null;

  constructor(opts: PauseMenuOptions) {
    this.opts = opts;
  }

  /** Whether the overlay is currently mounted. */
  get open(): boolean {
    return this.root !== null;
  }

  mount(root: HTMLElement): void {
    if (this.root !== null) return;

    this.menuEl = el('div', { class: 'gk-pause__menu' }, [
      el('h2', { class: 'gk-pause__title gk-display', text: 'Paused' }),
      button('Resume', 'gk-pause__btn gk-pause__btn--primary gk-display', () => this.opts.onResume()),
      button('Settings', 'gk-pause__btn gk-display', () => this.showSettings(true)),
      button('Quit to Lobby', 'gk-pause__btn gk-display', () => this.opts.onQuitToLobby()),
    ]);

    this.settingsEl = el('div', { class: 'gk-pause__settings' });

    this.root = el('div', { class: 'gk-pause' }, [this.menuEl, this.settingsEl]);
    root.appendChild(this.root);
    this.showSettings(false);
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
    this.menuEl = null;
    this.settingsEl = null;
    this.settingsPanel = null;
  }

  private showSettings(show: boolean): void {
    this.menuEl?.classList.toggle('is-hidden', show);
    this.settingsEl?.classList.toggle('is-visible', show);
    if (show && this.settingsPanel === null && this.settingsEl !== null) {
      this.settingsPanel = new SettingsPanel({
        showControls: false,
        onChange: (s) => this.opts.onSettingsChange?.(s),
      });
      this.settingsEl.append(
        this.settingsPanel.render(),
        button('Back', 'gk-pause__btn gk-display', () => this.showSettings(false)),
      );
    }
  }
}
