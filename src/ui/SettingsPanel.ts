/**
 * Settings panel component (WP-F). Shared by the lobby SETTINGS view and the
 * pause menu (BLUEPRINT §12): master / music / SFX sliders + a mute toggle,
 * persisted to `gk-settings`, plus (in the lobby) a controls reference table
 * (BLUEPRINT §4). Not a Screen — a mountable sub-component.
 * WP-M added Graphics quality (Auto/Low/Medium/High via render/quality.ts)
 * and mouse sensitivity (`gk-settings.sensitivity`), shown in both places.
 */

import { el, button } from './dom';
import { speakerSvg } from './icons';
import {
  type GkSettings,
  DEFAULT_SENSITIVITY,
  MAX_SENSITIVITY,
  MIN_SENSITIVITY,
  loadSettings,
  saveSettings,
} from './storage';
// The one render module the UI may import (WP-M): quality state lives there,
// works outside a match, and SceneManager/Stadium subscribe to its changes.
import {
  type QualitySetting,
  type QualityTier,
  QUALITY_SETTINGS,
  getQualitySetting,
  getQualityTier,
  onQualityChange,
  setQualitySetting,
} from '../render/quality';

/** The player controls reference (BLUEPRINT §4 + v1.1 lock-on). */
const CONTROLS: readonly (readonly [string, string])[] = [
  ['WASD', 'Move (camera-relative)'],
  ['Mouse', 'Orbit camera / aim'],
  ['LMB', 'Attack (3-hit combo)'],
  ['RMB (hold)', 'Block'],
  ['Shift', 'Special ability'],
  ['Q', 'Ultimate (at full charge)'],
  ['Space', 'Jump (Eagle: hold to glide)'],
  ['E / MMB', 'Lock-on toggle (camera + aim follow the target)'],
  ['Tab', 'Lock-on: next nearest enemy'],
  ['Esc', 'Pause'],
];

const QUALITY_LABEL: Record<QualitySetting, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const TIER_LABEL: Record<QualityTier, string> = { low: 'Low', medium: 'Medium', high: 'High' };

export interface SettingsPanelOptions {
  /** Include the controls reference table (lobby yes, pause no). */
  showControls?: boolean;
  /** Notified on every change with the fresh, already-persisted settings. */
  onChange?: (settings: GkSettings) => void;
}

const SLIDERS: readonly (readonly [keyof Pick<GkSettings, 'master' | 'music' | 'sfx'>, string])[] = [
  ['master', 'Master'],
  ['music', 'Music'],
  ['sfx', 'SFX'],
];

export class SettingsPanel {
  private readonly opts: SettingsPanelOptions;
  private settings: GkSettings;
  private root: HTMLElement | null = null;
  private muteBtn: HTMLButtonElement | null = null;

  constructor(opts: SettingsPanelOptions = {}) {
    this.opts = opts;
    this.settings = loadSettings();
  }

  /** Build and return the panel element (caller appends it). */
  render(): HTMLElement {
    const rows = SLIDERS.map(([key, label]) => this.sliderRow(key, label));

    this.muteBtn = button(this.settings.muted ? 'Muted' : 'Mute', 'gk-settings__mute', () => this.toggleMute());
    this.muteBtn.classList.toggle('is-muted', this.settings.muted);
    this.refreshMuteBtn();

    const audio = el('div', { class: 'gk-settings__group' }, [
      el('h3', { class: 'gk-settings__heading gk-display', text: 'Audio' }),
      ...rows,
      el('div', { class: 'gk-settings__muterow' }, [this.muteBtn]),
    ]);

    const children: HTMLElement[] = [audio, this.graphicsGroup(), this.mouseGroup()];
    if (this.opts.showControls === true && window.gkDesktop !== undefined) children.push(this.desktopGroup());
    if (this.opts.showControls === true) children.push(this.controlsTable());

    this.root = el('div', { class: 'gk-settings' }, children);
    return this.root;
  }

  /** Current settings snapshot (for callers that want to seed audio on open). */
  getSettings(): GkSettings {
    return { ...this.settings };
  }

  private sliderRow(key: 'master' | 'music' | 'sfx', label: string): HTMLElement {
    const value = el('span', { class: 'gk-settings__value', text: `${Math.round(this.settings[key] * 100)}` });
    const input = el('input', {
      class: 'gk-settings__slider',
      attrs: { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(this.settings[key] * 100)) },
    });
    input.addEventListener('input', () => {
      const v = Number(input.value) / 100;
      this.settings = { ...this.settings, [key]: v };
      value.textContent = `${Math.round(v * 100)}`;
      this.commit();
    });
    return el('label', { class: 'gk-settings__row' }, [
      el('span', { class: 'gk-settings__label', text: label }),
      input,
      value,
    ]);
  }

  /**
   * Graphics quality (WP-M): Auto / Low / Medium / High segmented control,
   * persisted by `quality.ts` under `gk-quality` and applied live (a running
   * SceneManager/Stadium re-tier on the change notification).
   */
  private graphicsGroup(): HTMLElement {
    const hint = el('p', { class: 'gk-settings__hint' });
    const buttons = QUALITY_SETTINGS.map((q) => {
      const b = button(QUALITY_LABEL[q], 'gk-settings__seg-btn', () => setQualitySetting(q), {
        attrs: { 'data-quality': q, 'aria-pressed': 'false' },
      });
      return b;
    });
    const refresh = (): void => {
      const setting = getQualitySetting();
      const tier = getQualityTier();
      for (const b of buttons) {
        const on = b.dataset.quality === setting;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      hint.textContent =
        setting === 'auto'
          ? `Now rendering at ${TIER_LABEL[tier]}. Auto starts at High and steps down if the frame rate stays low.`
          : setting === 'low'
            ? 'Low: no post-processing or outlines. Best for older or integrated GPUs.'
            : setting === 'medium'
              ? 'Medium: tone mapping and color grade with lighter effects.'
              : 'High: the full look, with bloom, outlines and every effect.';
    };
    refresh();
    const unsubscribe = onQualityChange(() => {
      // Panels are dropped without a teardown hook; unsubscribe once detached.
      if (this.root !== null && !this.root.isConnected) {
        unsubscribe();
        return;
      }
      refresh();
    });
    return el('div', { class: 'gk-settings__group' }, [
      el('h3', { class: 'gk-settings__heading gk-display', text: 'Graphics' }),
      el('div', { class: 'gk-settings__row gk-settings__row--seg' }, [
        el('span', { class: 'gk-settings__label', text: 'Quality' }),
        el('div', { class: 'gk-settings__seg', attrs: { role: 'group', 'aria-label': 'Graphics quality' } }, buttons),
      ]),
      hint,
    ]);
  }

  /** Mouse sensitivity slider (WP-M): stored as rad/px, shown as a × multiplier. */
  private mouseGroup(): HTMLElement {
    const toMult = (s: number): number => s / DEFAULT_SENSITIVITY;
    const fmt = (s: number): string => `${toMult(s).toFixed(2)}×`;
    const value = el('span', { class: 'gk-settings__value gk-settings__value--wide', text: fmt(this.settings.sensitivity) });
    const input = el('input', {
      class: 'gk-settings__slider',
      attrs: {
        type: 'range',
        min: String(Math.round(toMult(MIN_SENSITIVITY) * 100)),
        max: String(Math.round(toMult(MAX_SENSITIVITY) * 100)),
        step: '5',
        value: String(Math.round(toMult(this.settings.sensitivity) * 100)),
        'aria-label': 'Mouse sensitivity',
      },
    });
    input.addEventListener('input', () => {
      const s = (Number(input.value) / 100) * DEFAULT_SENSITIVITY;
      this.settings = { ...this.settings, sensitivity: s };
      value.textContent = fmt(s);
      this.commit();
    });
    return el('div', { class: 'gk-settings__group' }, [
      el('h3', { class: 'gk-settings__heading gk-display', text: 'Mouse' }),
      el('label', { class: 'gk-settings__row' }, [
        el('span', { class: 'gk-settings__label', text: 'Sensitivity' }),
        input,
        value,
      ]),
    ]);
  }

  /** Desktop app only (WP-L): the notify-only update-check toggle (`checkUpdates`). */
  private desktopGroup(): HTMLElement {
    const input = el('input', { class: 'gk-settings__check', attrs: { type: 'checkbox' } });
    input.checked = this.settings.checkUpdates;
    input.addEventListener('change', () => {
      this.settings = { ...this.settings, checkUpdates: input.checked };
      this.commit();
    });
    return el('div', { class: 'gk-settings__group' }, [
      el('h3', { class: 'gk-settings__heading gk-display', text: 'Desktop' }),
      el('label', { class: 'gk-settings__toggle' }, [
        input,
        el('span', { class: 'gk-settings__label', text: 'Check for updates at launch' }),
      ]),
      el('p', { class: 'gk-settings__hint', text: 'Only notifies you — nothing is downloaded automatically. F11 toggles fullscreen.' }),
    ]);
  }

  private controlsTable(): HTMLElement {
    const rows = CONTROLS.map(([keys, action]) =>
      el('div', { class: 'gk-controls__row' }, [
        el('kbd', { class: 'gk-controls__key', text: keys }),
        el('span', { class: 'gk-controls__action', text: action }),
      ]),
    );
    return el('div', { class: 'gk-settings__group' }, [
      el('h3', { class: 'gk-settings__heading gk-display', text: 'Controls' }),
      el('div', { class: 'gk-controls' }, rows),
    ]);
  }

  private toggleMute(): void {
    this.settings = { ...this.settings, muted: !this.settings.muted };
    this.refreshMuteBtn();
    this.commit();
  }

  private refreshMuteBtn(): void {
    if (this.muteBtn === null) return;
    this.muteBtn.classList.toggle('is-muted', this.settings.muted);
    this.muteBtn.innerHTML = `${speakerSvg(this.settings.muted)}<span>${this.settings.muted ? 'Muted' : 'Mute'}</span>`;
  }

  private commit(): void {
    saveSettings(this.settings);
    this.opts.onChange?.({ ...this.settings });
  }
}
