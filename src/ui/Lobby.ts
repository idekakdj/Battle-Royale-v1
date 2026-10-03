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
import {
  type GkSettings,
  loadSettings,
  saveSettings,
  SETTINGS_KEY,
  ANIMAL_KEY,
  DIFFICULTY_KEY,
} from './storage';
import { VersionPanel } from './VersionPanel';
import { APP_VERSION, APP_VERSION_LABEL, consumeWhatsNew, getChangelog, requestUpdateCheck } from '../version';

/** App version shown in the lobby footer (package.json via `__APP_VERSION__`). */
const VERSION = APP_VERSION_LABEL;

/** Session-wide lobby flags (WP-L): auto "What's New" runs once, banner dismissal sticks. */
const lobbySession = { whatsNewChecked: false, updateDismissed: false };

export interface LobbyOptions {
  /** PLAY → character select (BLUEPRINT §3). */
  onPlay: () => void;
  /** v1.4: CHAMPIONS LEAGUE nav (platform-fighter mode → its setup screen). The entry is hidden when omitted. */
  onChampionsLeague?: () => void;
  /** GLADIATORS nav; defaults to {@link LobbyOptions.onPlay} if omitted. */
  onGladiators?: () => void;
  /** The lobby default gladiator to preview (from `gk-animal`). */
  getSelectedAnimal: () => AnimalId;
  /** Notified when the player changes audio settings. */
  onSettingsChange?: (settings: GkSettings) => void;
}

type NavId = 'play' | 'brawl' | 'gladiators' | 'settings';

export class Lobby implements Screen {
  private readonly opts: LobbyOptions;
  private root: HTMLElement | null = null;
  private preview: PreviewPane | null = null;
  private settingsPanel: SettingsPanel | null = null;
  private detailEl: HTMLElement | null = null;
  private settingsHost: HTMLElement | null = null;
  private muteBtn: HTMLButtonElement | null = null;
  private activeNav: NavId = 'play';
  private versionPanel: VersionPanel | null = null;

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
      this.opts.onChampionsLeague !== undefined ? this.navButton('brawl', 'Champions League') : null,
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
    const desktop = window.gkDesktop;
    const bottomBar = el('div', { class: 'gk-lobby__bottombar' }, [
      el('div', { class: 'gk-lobby__bottomgroup' }, [
        el('span', { class: 'gk-lobby__version', text: `Gladiator Kingdom · ${VERSION}` }),
        button("What's New", 'gk-lobby__whatsnew', () => this.openVersionPanel(false), {
          title: 'Version history',
        }),
      ]),
      el('div', { class: 'gk-lobby__bottomgroup' }, [
        desktop !== undefined ? button('Quit', 'gk-lobby__quit', () => desktop.quit(), { title: 'Quit game' }) : null,
        this.muteBtn,
      ]),
    ]);

    const stage = el('div', { class: 'gk-lobby__stage' }, [this.detailEl, this.settingsHost, playBtn]);

    this.root = el('div', { class: 'gk-screen gk-lobby' }, [logo, nav, stage, bottomBar]);
    this.root.style.setProperty('--lobby-accent', ANIMALS[animal].accent);
    root.appendChild(this.root);

    this.showNav('play');
    this.initVersionFeatures();
  }

  unmount(): void {
    this.versionPanel?.close();
    this.versionPanel = null;
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
    if (id === 'brawl') {
      this.opts.onChampionsLeague?.();
      return;
    }
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

  // ── Version history + update notice (WP-L) ─────────────────────────────────

  /** First lobby of the session: auto "What's New" after an update; update banner (desktop). */
  private initVersionFeatures(): void {
    if (!lobbySession.whatsNewChecked) {
      lobbySession.whatsNewChecked = true;
      if (consumeWhatsNew(APP_VERSION, [SETTINGS_KEY, ANIMAL_KEY, DIFFICULTY_KEY])) this.openVersionPanel(true);
    }
    if (lobbySession.updateDismissed) return;
    void requestUpdateCheck(loadSettings().checkUpdates, APP_VERSION).then((info) => {
      if (info !== null && this.root !== null && !lobbySession.updateDismissed) this.showUpdateBanner(info);
    });
  }

  private openVersionPanel(whatsNew: boolean): void {
    if (this.root === null || this.versionPanel?.isOpen === true) return;
    this.versionPanel = new VersionPanel({
      entries: getChangelog(),
      currentVersion: APP_VERSION,
      whatsNew,
      onClose: () => {
        this.versionPanel = null;
      },
    });
    this.versionPanel.open(this.root);
  }

  private showUpdateBanner(info: GkUpdateInfo): void {
    if (this.root === null || this.root.querySelector('.gk-lobby__update') !== null) return;
    const banner = el('div', { class: 'gk-lobby__update', attrs: { role: 'status' } }, [
      el('span', { class: 'gk-lobby__update-text', text: `Update v${info.version} available` }),
      button('Download', 'gk-lobby__update-btn', () => window.gkDesktop?.openExternal(info.url), {
        title: 'Open the release page in your browser',
      }),
      button('×', 'gk-lobby__update-close', () => {
        lobbySession.updateDismissed = true;
        banner.remove();
      }, { attrs: { 'aria-label': 'Dismiss update notice' } }),
    ]);
    this.root.appendChild(banner);
  }

  private refreshMuteBtn(): void {
    if (this.muteBtn === null) return;
    const muted = loadSettings().muted;
    this.muteBtn.classList.toggle('is-muted', muted);
    this.muteBtn.innerHTML = speakerSvg(muted);
    this.muteBtn.title = muted ? 'Unmute' : 'Mute';
  }
}
