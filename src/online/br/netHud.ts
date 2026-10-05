/**
 * NetHud (WP-N6): the small DOM overlay of an online Battle Royale — a ping / loss chip, a centred "waiting / reconnecting"
 * banner and short toasts ("Ann left — a bot takes over"). Pointer-transparent; every string goes through `textContent`.
 */

import '../../styles/netbr.css';
import type { NetHudState } from './netHudModel';

const TOAST_MS = 4500;
const MAX_TOASTS = 4;

export class NetHud {
  private root: HTMLElement | null = null;
  private chip!: HTMLElement;
  private banner!: HTMLElement;
  private toasts!: HTMLElement;
  private text = '';
  private quality = '';
  private bannerText: string | null = null;
  private readonly timers = new Set<number>();

  mount(host: HTMLElement): void {
    if (this.root !== null) return;
    this.chip = document.createElement('div');
    this.chip.className = 'gk-nethud__chip';
    this.banner = document.createElement('div');
    this.banner.className = 'gk-nethud__banner gk-display';
    this.banner.hidden = true;
    this.toasts = document.createElement('div');
    this.toasts.className = 'gk-nethud__toasts';
    const root = document.createElement('div');
    root.className = 'gk-nethud';
    root.setAttribute('aria-live', 'polite');
    root.append(this.chip, this.banner, this.toasts);
    host.appendChild(root);
    this.root = root;
  }

  update(state: NetHudState): void {
    if (this.root === null) return;
    if (state.text !== this.text) {
      this.text = state.text;
      this.chip.textContent = state.text;
    }
    if (state.quality !== this.quality) {
      this.quality = state.quality;
      this.chip.dataset.quality = state.quality;
    }
    if (state.banner !== this.bannerText) {
      this.bannerText = state.banner;
      this.banner.hidden = state.banner === null;
      this.banner.textContent = state.banner ?? '';
    }
  }

  toast(message: string): void {
    if (this.root === null) return;
    const t = document.createElement('div');
    t.className = 'gk-nethud__toast';
    t.textContent = message;
    this.toasts.appendChild(t);
    while (this.toasts.childElementCount > MAX_TOASTS) this.toasts.firstElementChild?.remove();
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      t.classList.add('is-fading');
      const id2 = window.setTimeout(() => {
        this.timers.delete(id2);
        t.remove();
      }, 450);
      this.timers.add(id2);
    }, TOAST_MS);
    this.timers.add(id);
  }

  dispose(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.root?.remove();
    this.root = null;
  }
}
