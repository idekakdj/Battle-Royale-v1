/**
 * Lobby screen (WP-F, BLUEPRINT §12 — Fortnite-inspired).
 *
 * Full-bleed dark-stone hall: left vertical nav (PLAY / GLADIATORS / SETTINGS),
 * top-left crossed-swords logo, a center-right 3D preview of the currently
 * selected gladiator on a pedestal, a huge gold PLAY button bottom-right, and a
 * bottom bar with the version and a mute toggle. The SETTINGS nav opens the
 * shared {@link SettingsPanel} (sliders + mute + controls reference).
 *
 * Navigation is via injected callbacks — the lobby imports no sim/render/audio.
 */

import type { Screen } from '../core/ScreenManager';
import type { AnimalId } from '../core/types';
import { el, button } from './dom';
import { crossedSwordsSvg, speakerSvg } from './icons';
import { PreviewPane } from './PreviewPane';
import { SettingsPanel } from './SettingsPanel';
import { ANIMALS } from '../config/animals';
import { type GkSettings, loadSettings, saveSettings } from './storage';

/** App version shown in the lobby footer. */
const VERSION = 'v1.0';

export interface LobbyOptions {
  /** PLAY → character select (BLUEPRINT §3). */
  onPlay: () => void;
  /** GLADIATORS nav; defaults to {@link LobbyOptions.onPlay} if omitted. */
  onGladiators?: () => void;
  /** The lobby default gladiator to preview (from `gk-animal`). */
  getSelectedAnimal: () => AnimalId;
  /** Notified when the player changes audio settings. */
  onSettingsChange?: (settings: GkSettings) => void;
}

type NavId = 'play' | 'gladiators' | 'settings';

export class Lobby implements Screen {
  private readonly opts: LobbyOptions;
  private root: HTMLElement | null = null;
  private preview: PreviewPane | null = null;
  private settingsPanel: SettingsPanel | null = null;
  private detailEl: HTMLElement | null = null;
  private settingsHost: HTMLElement | null = null;
  private muteBtn: HTMLButtonElement | null = null;
  private activeNav: NavId = 'play';

  constructor(opts: LobbyOptions) {
    this.opts = opts;
  }

  mount(root: HTMLElement): void {
    const animal = this.opts.getSelectedAnimal();
    this.preview = new PreviewPane(animal, 'gk-preview gk-lobby__preview');

    // ── Logo (top-left) ──────────────────────────────────────────────────────
    const logo = el('div', { class: 'gk-lobby__logo' }, [
      el('span', { class: 'gk-lobby__logo-mark', html: crossedSwordsSvg() }),
      el('span', { class: 'gk-lobby__logo-text gk-display' }, [
        el('span', { class: 'gk-lobby__logo-l1', text: 'Gladiator' }),
        el('span', { class: 'gk-lobby__logo-l2', text: 'Kingdom' }),
      ]),
    ]);

    // ── Left nav ─────────────────────────────────────────────────────────────
    const nav = el('nav', { class: 'gk-lobby__nav' }, [
      this.navButton('play', 'Play'),
      this.navButton('gladiators', 'Gladiators'),
      this.navButton('settings', 'Settings'),
    ]);

    // ── Center-right detail area (preview + settings swap in here) ────────────
    this.detailEl = el('div', { class: 'gk-lobby__detail' }, [this.preview.root]);
    this.settingsHost = el('div', { class: 'gk-lobby__settings-host' });

    // ── Big gold PLAY button (bottom-right) ──────────────────────────────────
    const playBtn = button('Play', 'gk-lobby__play gk-display', () => this.opts.onPlay());

    // ── Bottom bar ───────────────────────────────────────────────────────────
    this.muteBtn = button('', 'gk-lobby__mute', () => this.toggleMute());
    this.refreshMuteBtn();
    const bottomBar = el('div', { class: 'gk-lobby__bottombar' }, [
      el('span', { class: 'gk-lobby__version', text: `Gladiator Kingdom · ${VERSION}` }),
      this.muteBtn,
    ]);

    const stage = el('div', { class: 'gk-lobby__stage' }, [this.detailEl, this.settingsHost, playBtn]);

    this.root = el('div', { class: 'gk-screen gk-lobby' }, [logo, nav, stage, bottomBar]);
    this.root.style.setProperty('--lobby-accent', ANIMALS[animal].accent);
    root.appendChild(this.root);

    this.showNav('play');
  }

  unmount(): void {
    this.preview?.dispose();
    this.preview = null;
    this.root?.remove();
    this.root = null;
  }

  private navButton(id: NavId, label: string): HTMLButtonElement {
    const b = button(label, 'gk-lobby__navbtn gk-display', () => this.showNav(id), { dataset: { nav: id } });
    return b;
  }

  private showNav(id: NavId): void {
    if (id === 'gladiators') {
      (this.opts.onGladiators ?? this.opts.onPlay)();
      return;
    }
    this.activeNav = id;
    if (this.root !== null) {
      for (const b of this.root.querySelectorAll<HTMLElement>('.gk-lobby__navbtn')) {
        b.classList.toggle('is-active', b.dataset.nav === id);
      }
    }
    const showingSettings = id === 'settings';
    this.detailEl?.classList.toggle('is-hidden', showingSettings);
    this.settingsHost?.classList.toggle('is-visible', showingSettings);
    if (showingSettings) this.ensureSettingsPanel();
  }

  private ensureSettingsPanel(): void {
    if (this.settingsPanel !== null || this.settingsHost === null) return;
    this.settingsPanel = new SettingsPanel({
      showControls: true,
      onChange: (s) => {
        this.refreshMuteBtn();
        this.opts.onSettingsChange?.(s);
      },
    });
    this.settingsHost.appendChild(this.settingsPanel.render());
  }

  private toggleMute(): void {
    const s = loadSettings();
    const next: GkSettings = { ...s, muted: !s.muted };
    saveSettings(next);
    this.refreshMuteBtn();
    this.opts.onSettingsChange?.(next);
    // Keep an open settings panel in sync by rebuilding it next open.
    if (this.activeNav === 'settings' && this.settingsHost !== null) {
      this.settingsHost.replaceChildren();
      this.settingsPanel = null;
      this.ensureSettingsPanel();
    }
  }

  private refreshMuteBtn(): void {
    if (this.muteBtn === null) return;
    const muted = loadSettings().muted;
    this.muteBtn.classList.toggle('is-muted', muted);
    this.muteBtn.innerHTML = speakerSvg(muted);
    this.muteBtn.title = muted ? 'Unmute' : 'Mute';
  }
}
