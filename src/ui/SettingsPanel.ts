/**
 * Settings panel component (WP-F). Shared by the lobby SETTINGS view and the
 * pause menu (BLUEPRINT §12): master / music / SFX sliders + a mute toggle,
 * persisted to `gk-settings`, plus (in the lobby) a controls reference table
 * (BLUEPRINT §4). Not a Screen — a mountable sub-component.
 */

import { el, button } from './dom';
import { speakerSvg } from './icons';
import { type GkSettings, loadSettings, saveSettings } from './storage';

/** The player controls reference (BLUEPRINT §4). */
const CONTROLS: readonly (readonly [string, string])[] = [
  ['WASD', 'Move (camera-relative)'],
  ['Mouse', 'Orbit camera / aim'],
  ['LMB', 'Attack (3-hit combo)'],
  ['RMB (hold)', 'Block'],
  ['Shift', 'Special ability'],
  ['Q', 'Ultimate (at full charge)'],
  ['Space', 'Jump (Eagle: hold to glide)'],
  ['Esc', 'Pause'],
];

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

    const children: HTMLElement[] = [audio];
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
