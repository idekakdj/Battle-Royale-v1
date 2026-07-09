/**
 * In-match HUD (WP-F, BLUEPRINT §12). NOT a Screen — the match controller
 * (WP-I) owns its lifecycle: `mount(root)` once, `update(snapshot, playerId)`
 * every render frame, and the event methods on the matching EventBus events.
 *
 * Layout (all DOM/CSS over the WebGL canvas):
 *  - bottom-left: HP bar (animal accent + white damage-chip trail) over a guard bar
 *  - bottom-center: active buff icons
 *  - bottom-right: special icon with radial cooldown + ultimate ring (0–100,
 *    pulse + "Q READY" at full)
 *  - top-right: "⚔ N ALIVE" · top-left: kill feed (icon ▸ icon, 4 s fade)
 *  - top-center: bloodlust banner · center: 3-2-1-FIGHT countdown + hitmarker
 *  - low-HP vignette below 30%, controls hint for the first 10 s of sim time,
 *    spectate bar variant after player death.
 */

import type { AnimalId, BuffState, WorldSnapshot } from '../core/types';
import { ANIMALS } from '../config/animals';
import { el } from './dom';
import { animalHeadSvg } from './icons';

/** One kill-feed line: killer icon ▸ victim icon (BLUEPRINT §12). */
export interface KillFeedEntry {
  killerAnimal: AnimalId;
  victimAnimal: AnimalId;
  /** Highlights the row gold when the player scored the kill. */
  killerIsPlayer?: boolean;
  /** Highlights the row red when the player died. */
  victimIsPlayer?: boolean;
}

/** Countdown steps for the pre-match 3-2-1-FIGHT display. */
export type CountdownStep = 3 | 2 | 1 | 'FIGHT';

/** Spectate-bar target info; `null` hides the bar. */
export interface SpectateTarget {
  /** Display name, e.g. "LION (BOT)". */
  name: string;
  animal: AnimalId;
}

const KILLFEED_TTL_MS = 4000;
const CONTROLS_HINT_SIM_T = 10; // seconds of sim time before the hint fades
const LOW_HP_FRAC = 0.3;

/** Buff chip presentation per {@link BuffState.kind}. */
const BUFF_META: Record<BuffState['kind'], { label: string; good: boolean }> = {
  speed: { label: 'SPD', good: true },
  rage: { label: 'RAGE', good: true },
  slow: { label: 'SLOW', good: false },
  bleed: { label: 'BLD', good: false },
  root: { label: 'ROOT', good: false },
  blind: { label: 'BLND', good: false },
  dmgTakenUp: { label: 'VULN', good: false },
  armorUp: { label: 'ARMR', good: true },
  atkSpeedUp: { label: 'HAST', good: true },
  stealth: { label: 'STLH', good: true },
};

export class HUD {
  private root: HTMLElement | null = null;

  // Cached element refs (created in mount).
  private hpFill!: HTMLElement;
  private hpChip!: HTMLElement;
  private hpText!: HTMLElement;
  private guardFill!: HTMLElement;
  private buffBar!: HTMLElement;
  private specialCell!: HTMLElement;
  private specialCdText!: HTMLElement;
  private ultCell!: HTMLElement;
  private ultReady!: HTMLElement;
  private aliveText!: HTMLElement;
  private killFeedEl!: HTMLElement;
  private bloodlustEl!: HTMLElement;
  private countdownEl!: HTMLElement;
  private hitmarkerEl!: HTMLElement;
  private vignetteEl!: HTMLElement;
  private controlsHint!: HTMLElement;
  private spectateEl!: HTMLElement;
  private nameplate!: HTMLElement;

  // Update-diffing state.
  private lastHp = -1;
  private lastAnimal: AnimalId | null = null;
  private buffKey = '';
  private hintHidden = false;
  private hitmarkerTimer: number | null = null;
  private bloodlustTimer: number | null = null;
  private countdownTimer: number | null = null;

  mount(root: HTMLElement): void {
    if (this.root !== null) this.unmount();

    // Bottom-left vitals.
    this.hpChip = el('div', { class: 'gk-hud__hp-chip' });
    this.hpFill = el('div', { class: 'gk-hud__hp-fill' });
    this.hpText = el('span', { class: 'gk-hud__hp-text' });
    this.guardFill = el('div', { class: 'gk-hud__guard-fill' });
    this.nameplate = el('div', { class: 'gk-hud__nameplate gk-display' });
    const vitals = el('div', { class: 'gk-hud__vitals' }, [
      this.nameplate,
      el('div', { class: 'gk-hud__hp' }, [this.hpChip, this.hpFill, this.hpText]),
      el('div', { class: 'gk-hud__guard' }, [this.guardFill]),
    ]);

    // Bottom-center buffs.
    this.buffBar = el('div', { class: 'gk-hud__buffs' });

    // Bottom-right ability cluster.
    this.specialCdText = el('span', { class: 'gk-hud__cd-text' });
    this.specialCell = el('div', { class: 'gk-hud__ability gk-hud__ability--special' }, [
      el('span', { class: 'gk-hud__ability-key', text: 'SHIFT' }),
      this.specialCdText,
    ]);
    this.ultReady = el('span', { class: 'gk-hud__ult-ready gk-display', text: 'Q READY' });
    this.ultCell = el('div', { class: 'gk-hud__ability gk-hud__ability--ult' }, [
      el('span', { class: 'gk-hud__ability-key', text: 'Q' }),
      this.ultReady,
    ]);
    const abilities = el('div', { class: 'gk-hud__abilities' }, [this.specialCell, this.ultCell]);

    // Corners / overlays.
    this.aliveText = el('div', { class: 'gk-hud__alive gk-display', text: '⚔ 10 ALIVE' });
    this.killFeedEl = el('div', { class: 'gk-hud__killfeed' });
    this.bloodlustEl = el('div', { class: 'gk-hud__bloodlust gk-display' });
    this.countdownEl = el('div', { class: 'gk-hud__countdown gk-display' });
    this.hitmarkerEl = el('div', { class: 'gk-hud__hitmarker', html: hitmarkerSvg() });
    this.vignetteEl = el('div', { class: 'gk-hud__vignette' });
    this.controlsHint = el('div', { class: 'gk-hud__hint' }, [
      hintKey('WASD', 'Move'),
      hintKey('LMB', 'Attack'),
      hintKey('RMB', 'Block'),
      hintKey('SHIFT', 'Special'),
      hintKey('Q', 'Ultimate'),
      hintKey('SPACE', 'Jump'),
    ]);
    this.spectateEl = el('div', { class: 'gk-hud__spectate gk-display' });

    this.root = el('div', { class: 'gk-hud' }, [
      this.vignetteEl,
      vitals,
      this.buffBar,
      abilities,
      this.aliveText,
      this.killFeedEl,
      this.bloodlustEl,
      this.countdownEl,
      this.hitmarkerEl,
      this.controlsHint,
      this.spectateEl,
    ]);
    root.appendChild(this.root);

    this.lastHp = -1;
    this.lastAnimal = null;
    this.buffKey = '';
    this.hintHidden = false;
  }

  unmount(): void {
    if (this.hitmarkerTimer !== null) window.clearTimeout(this.hitmarkerTimer);
    if (this.bloodlustTimer !== null) window.clearTimeout(this.bloodlustTimer);
    if (this.countdownTimer !== null) window.clearTimeout(this.countdownTimer);
    this.hitmarkerTimer = this.bloodlustTimer = this.countdownTimer = null;
    this.root?.remove();
    this.root = null;
  }

  /** Drive the HUD from the latest snapshot; call every render frame. */
  update(snapshot: WorldSnapshot, playerId: number): void {
    if (this.root === null) return;
    const player = snapshot.fighters.find((f) => f.id === playerId);

    // "⚔ N ALIVE"
    let alive = 0;
    for (const f of snapshot.fighters) if (f.alive) alive++;
    this.aliveText.textContent = `⚔ ${alive} ALIVE`;

    // Controls hint: fade after the first 10 s of sim time (pause-safe).
    if (!this.hintHidden && snapshot.time > CONTROLS_HINT_SIM_T) {
      this.hintHidden = true;
      this.controlsHint.classList.add('is-hidden');
    }

    if (player === undefined) return;

    // Accent + nameplate follow the player's animal (set once).
    if (player.animal !== this.lastAnimal) {
      this.lastAnimal = player.animal;
      const def = ANIMALS[player.animal];
      this.root.style.setProperty('--hud-accent', def.accent);
      this.nameplate.textContent = def.displayName;
    }

    // HP bar + white damage-chip trail. Bars fill via scaleX (transform-only
    // transitions, §12); the chip only moves when hp changes so its lagging
    // drain transition can play out behind the instant accent fill.
    const hpFrac = player.maxHp > 0 ? Math.max(0, player.hp / player.maxHp) : 0;
    if (player.hp !== this.lastHp) {
      const prev = this.lastHp;
      this.lastHp = player.hp;
      this.hpFill.style.transform = `scaleX(${hpFrac})`;
      if (prev >= 0 && player.hp < prev) {
        this.hpChip.style.transform = `scaleX(${hpFrac})`; // transitions down slowly
      } else {
        // First fill or a heal: snap the chip to the bar.
        this.hpChip.style.transition = 'none';
        this.hpChip.style.transform = `scaleX(${hpFrac})`;
        void this.hpChip.offsetWidth; // flush so the next drop transitions again
        this.hpChip.style.transition = '';
      }
      this.hpText.textContent = `${Math.max(0, Math.round(player.hp))} / ${player.maxHp}`;
    }

    // Guard bar.
    const guardFrac = player.maxGuard > 0 ? Math.max(0, player.guard / player.maxGuard) : 0;
    this.guardFill.style.transform = `scaleX(${guardFrac})`;

    // Buff icons (rebuild only when the set changes).
    this.updateBuffs(player.buffs);

    // Special radial cooldown.
    const cdMax = ANIMALS[player.animal].special.cooldown;
    const cdFrac = cdMax > 0 ? Math.min(1, player.specialCd / cdMax) : 0;
    this.specialCell.style.setProperty('--cd', String(cdFrac));
    this.specialCell.classList.toggle('is-ready', player.specialCd <= 0);
    this.specialCdText.textContent = player.specialCd > 0 ? `${Math.ceil(player.specialCd)}` : '';

    // Ultimate ring 0–100 with pulse + "Q READY" at full.
    const ultFrac = Math.min(1, player.ultCharge / 100);
    this.ultCell.style.setProperty('--ult', String(ultFrac));
    this.ultCell.classList.toggle('is-ready', player.ultCharge >= 100);

    // Low-HP vignette below 30% — deeper the lower you get.
    const low = player.alive && hpFrac < LOW_HP_FRAC;
    this.vignetteEl.classList.toggle('is-active', low);
    if (low) this.vignetteEl.style.setProperty('--low', String(1 - hpFrac / LOW_HP_FRAC));
  }

  /** Push a kill-feed line (top-left, fades after 4 s). */
  killFeed(entry: KillFeedEntry): void {
    if (this.root === null) return;
    const row = el('div', { class: 'gk-hud__kf-row' });
    if (entry.killerIsPlayer === true) row.classList.add('is-player-kill');
    if (entry.victimIsPlayer === true) row.classList.add('is-player-death');
    row.innerHTML = `
      <span class="gk-hud__kf-icon" style="color:${ANIMALS[entry.killerAnimal].accent}">${animalHeadSvg(entry.killerAnimal, 'gk-hud__kf-head')}</span>
      <span class="gk-hud__kf-sep">▸</span>
      <span class="gk-hud__kf-icon is-victim" style="color:${ANIMALS[entry.victimAnimal].accent}">${animalHeadSvg(entry.victimAnimal, 'gk-hud__kf-head')}</span>`;
    this.killFeedEl.appendChild(row);
    window.setTimeout(() => {
      row.classList.add('is-fading');
      window.setTimeout(() => row.remove(), 450);
    }, KILLFEED_TTL_MS);
  }

  /** Flash the Crowd's Bloodlust banner with the new damage multiplier. */
  bloodlust(mult: number): void {
    if (this.root === null) return;
    this.bloodlustEl.textContent = `CROWD'S BLOODLUST — ALL DAMAGE ×${mult.toFixed(2)}`;
    this.bloodlustEl.classList.remove('is-active');
    void this.bloodlustEl.offsetWidth; // restart the animation
    this.bloodlustEl.classList.add('is-active');
    if (this.bloodlustTimer !== null) window.clearTimeout(this.bloodlustTimer);
    this.bloodlustTimer = window.setTimeout(() => this.bloodlustEl.classList.remove('is-active'), 3200);
  }

  /** Subtle center hitmarker on a landed hit. */
  hitmarker(): void {
    if (this.root === null) return;
    this.hitmarkerEl.classList.remove('is-active');
    void this.hitmarkerEl.offsetWidth;
    this.hitmarkerEl.classList.add('is-active');
    if (this.hitmarkerTimer !== null) window.clearTimeout(this.hitmarkerTimer);
    this.hitmarkerTimer = window.setTimeout(() => this.hitmarkerEl.classList.remove('is-active'), 220);
  }

  /** Show one step of the 3-2-1-FIGHT countdown (sim frozen during 3-2-1). */
  countdown(step: CountdownStep): void {
    if (this.root === null) return;
    this.countdownEl.textContent = typeof step === 'number' ? String(step) : 'FIGHT';
    this.countdownEl.classList.toggle('is-fight', step === 'FIGHT');
    this.countdownEl.classList.remove('is-active');
    void this.countdownEl.offsetWidth;
    this.countdownEl.classList.add('is-active');
    if (this.countdownTimer !== null) window.clearTimeout(this.countdownTimer);
    this.countdownTimer = window.setTimeout(
      () => this.countdownEl.classList.remove('is-active'),
      step === 'FIGHT' ? 900 : 1100,
    );
  }

  /**
   * Toggle the spectate bar. Pass the currently-followed fighter (name shown
   * verbatim, e.g. "LION (BOT)") or `null` when returning to normal play/end.
   * Alive count continues to come from {@link update}.
   */
  setSpectate(target: SpectateTarget | null): void {
    if (this.root === null) return;
    const on = target !== null;
    this.root.classList.toggle('is-spectating', on);
    this.spectateEl.classList.toggle('is-active', on);
    if (target !== null) {
      this.spectateEl.innerHTML = `
        <span class="gk-hud__spectate-label">SPECTATING</span>
        <span class="gk-hud__spectate-icon" style="color:${ANIMALS[target.animal].accent}">${animalHeadSvg(target.animal, 'gk-hud__kf-head')}</span>
        <span class="gk-hud__spectate-name">${escapeHtml(target.name)}</span>
        <span class="gk-hud__spectate-hint">· LMB next</span>`;
    }
  }

  private updateBuffs(buffs: readonly BuffState[]): void {
    const key = buffs.map((b) => b.kind).join(',');
    if (key === this.buffKey) {
      // Same set — just refresh the duration fills.
      const chips = this.buffBar.children;
      for (let i = 0; i < buffs.length && i < chips.length; i++) {
        const b = buffs[i];
        (chips[i] as HTMLElement).style.setProperty('--t', String(b.dur > 0 ? 1 - b.t / b.dur : 0));
      }
      return;
    }
    this.buffKey = key;
    this.buffBar.replaceChildren();
    for (const b of buffs) {
      const meta = BUFF_META[b.kind];
      const chip = el('span', {
        class: `gk-hud__buff ${meta.good ? 'is-good' : 'is-bad'}`,
        text: meta.label,
      });
      chip.style.setProperty('--t', String(b.dur > 0 ? 1 - b.t / b.dur : 0));
      this.buffBar.appendChild(chip);
    }
  }
}

function hintKey(key: string, action: string): HTMLElement {
  return el('span', { class: 'gk-hud__hint-item' }, [
    el('kbd', { class: 'gk-hud__hint-key', text: key }),
    el('span', { class: 'gk-hud__hint-action', text: action }),
  ]);
}

function hitmarkerSvg(): string {
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M5 5 L9 9 M19 5 L15 9 M5 19 L9 15 M19 19 L15 15"
      stroke="#fff" stroke-width="2.4" stroke-linecap="round" fill="none"/>
  </svg>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
