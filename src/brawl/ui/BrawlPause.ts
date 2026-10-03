/**
 * Champions League — pause overlay (reuses the Battle Royale pause chrome `gk-pause`). NOT a Screen: the
 * controller mounts it over the HUD when Esc stops the sim. Resume / Restart / Controls / Quit to lobby.
 */

import { el, button } from '../../ui/dom';
import { BRAWL_CONTROLS } from './controlsRef';

export interface BrawlPauseOptions {
  onResume: () => void;
  onRestart: () => void;
  onQuitToLobby: () => void;
}

export class BrawlPause {
  private readonly opts: BrawlPauseOptions;
  private root: HTMLElement | null = null;
  private menuEl: HTMLElement | null = null;
  private controlsEl: HTMLElement | null = null;

  constructor(opts: BrawlPauseOptions) {
    this.opts = opts;
  }

  get open(): boolean {
    return this.root !== null;
  }

  mount(host: HTMLElement): void {
    if (this.root !== null) return;
    const resume = button('Resume', 'gk-pause__btn gk-pause__btn--primary gk-display', () => this.opts.onResume());
    this.menuEl = el('div', { class: 'gk-pause__menu gk-brawl-pause__menu' }, [
      el('h2', { class: 'gk-pause__title gk-display', text: 'Paused' }),
      resume,
      button('Restart', 'gk-pause__btn gk-display', () => this.opts.onRestart()),
      button('Controls', 'gk-pause__btn gk-display', () => this.showControls(true)),
      button('Quit to Lobby', 'gk-pause__btn gk-display', () => this.opts.onQuitToLobby()),
    ]);

    const rows = BRAWL_CONTROLS.map(([keys, action]) =>
      el('div', { class: 'gk-controls__row' }, [
        el('kbd', { class: 'gk-controls__key', text: keys }),
        el('span', { class: 'gk-controls__action', text: action }),
      ]),
    );
    this.controlsEl = el('div', { class: 'gk-pause__menu gk-brawl-pause__controls is-hidden' }, [
      el('h2', { class: 'gk-pause__title gk-display', text: 'Controls' }),
      el('div', { class: 'gk-controls' }, rows),
      button('Back', 'gk-pause__btn gk-display', () => this.showControls(false)),
    ]);

    this.root = el('div', { class: 'gk-pause gk-brawl-pause' }, [this.menuEl, this.controlsEl]);
    host.appendChild(this.root);
    resume.focus({ preventScroll: true });
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
    this.menuEl = null;
    this.controlsEl = null;
  }

  private showControls(show: boolean): void {
    this.menuEl?.classList.toggle('is-hidden', show);
    this.controlsEl?.classList.toggle('is-hidden', !show);
  }
}
