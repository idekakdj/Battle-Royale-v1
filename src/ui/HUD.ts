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

import type { AnimalId, BuffState, PickupState, TrapKind, WorldSnapshot } from '../core/types';
import { ANIMALS } from '../config/animals';
import { PICKUPS } from '../config/balance';
import { el } from './dom';
import { animalHeadSvg } from './icons';
import { abilityGlyphSvg } from './abilityIcons';
import { buffIconSvg, pickupIconSvg, trapGlyphSvg } from './buffIcons';

/** One kill-feed line: killer icon ▸ victim icon (BLUEPRINT §12). */
export interface KillFeedEntry {
  killerAnimal: AnimalId;
  victimAnimal: AnimalId;
  /** Highlights the row gold when the player scored the kill. */
  killerIsPlayer?: boolean;
  /** Highlights the row red when the player died. */
  victimIsPlayer?: boolean;
  /**
   * Set when the arena (not a rival) finished the victim. The feed should then
   * show a trap glyph instead of the killer's head; `killerAnimal` is ignored.
   */
  cause?: 'trap';
  /** Optional trap flavour for the glyph (flame / spikes); omitted → combined glyph. */
  trapKind?: TrapKind;
  /** v1.5 online: the human killer's / victim's chosen name, shown next to the head icon (omitted for bots and offline). */
  killerName?: string;
  victimName?: string;
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

/** Buff icon presentation per {@link BuffState.kind} (glyphs in `buffIcons.ts`). */
const BUFF_META: Record<BuffState['kind'], { label: string; good: boolean }> = {
  speed: { label: 'Speed', good: true },
  rage: { label: 'Power', good: true },
  slow: { label: 'Slowed', good: false },
  bleed: { label: 'Bleeding', good: false },
  root: { label: 'Rooted', good: false },
  blind: { label: 'Blinded', good: false },
  dmgTakenUp: { label: 'Vulnerable', good: false },
  armorUp: { label: 'Armoured', good: true },
  atkSpeedUp: { label: 'Haste', good: true },
  stealth: { label: 'Stealth', good: true },
};

/** Centre-lower pickup toast copy (numbers live from config). */
const TOAST_COPY: Record<PickupState['kind'], { title: string; sub: string }> = {
  heal: { title: `+${PICKUPS.healAmount} HP`, sub: 'HEAL' },
  speed: { title: 'SPEED', sub: `+${Math.round(PICKUPS.speedBonus * 100)}% move · ${PICKUPS.speedDur}s` },
  rage: { title: 'POWER', sub: `+${Math.round(PICKUPS.rageBonus * 100)}% damage · ${PICKUPS.rageDur}s` },
};
const TOAST_MS = 1500;

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
  private specialGlyph!: HTMLElement;
  private specialName!: HTMLElement;
  private ultCell!: HTMLElement;
  private ultReady!: HTMLElement;
  private ultGlyph!: HTMLElement;
  private ultPct!: HTMLElement;
  private ultName!: HTMLElement;
  private ultNoTarget!: HTMLElement;
  private ultHintEl!: HTMLElement;
  private lockTagEl!: HTMLElement;
  private aliveText!: HTMLElement;
  private killFeedEl!: HTMLElement;
  private bloodlustEl!: HTMLElement;
  private countdownEl!: HTMLElement;
  private hitmarkerEl!: HTMLElement;
  private vignetteEl!: HTMLElement;
  private controlsHint!: HTMLElement;
  private spectateEl!: HTMLElement;
  private nameplate!: HTMLElement;
  /** v1.8 jungle: "Swimming · 62 % speed" / "Mossy ground · 65 % speed" chip above the vitals (absolute: no layout shift). */
  private terrainTagEl!: HTMLElement;
  private lastTerrainTag: string | null = null;
  /** v1.5 online: own chosen name for the vitals plate (null = the animal's display name). */
  private playerName: string | null = null;
  private toastEl!: HTMLElement;
  private buffTimeEls: HTMLElement[] = [];
  private buffSecs: number[] = [];
  private toastTimer: number | null = null;
  private ultHintTimer: number | null = null;
  private ultShakeTimer: number | null = null;
  private lockTagOn = false;
  private ultPreviewState: 'off' | 'ok' | 'none' = 'off';

  // Update-diffing state.
  private lastHp = -1;
  private lastAnimal: AnimalId | null = null;
  private buffKey = '';
  private hintHidden = false;
  private lastCdText = '';
  private lastUltPct = -1;
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
    this.terrainTagEl = el('div', { class: 'gk-hud__terrain', attrs: { 'aria-live': 'off' } });
    const vitals = el('div', { class: 'gk-hud__vitals' }, [
      this.terrainTagEl,
      this.nameplate,
      el('div', { class: 'gk-hud__hp' }, [this.hpChip, this.hpFill, this.hpText]),
      el('div', { class: 'gk-hud__guard' }, [this.guardFill]),
    ]);

    // Bottom-center buffs.
    this.buffBar = el('div', { class: 'gk-hud__buffs' });

    // Bottom-right ability cluster: per-animal glyph (set on first update),
    // radial cooldown + numerals (special), charge ring + % / Q READY (ult),
    // key caps on the rim and the ability name underneath.
    this.specialGlyph = el('span', { class: 'gk-hud__ability-glyph' });
    this.specialCdText = el('span', { class: 'gk-hud__cd-text' });
    this.specialName = el('span', { class: 'gk-hud__ability-name' });
    this.specialCell = el('div', { class: 'gk-hud__ability gk-hud__ability--special' }, [
      this.specialGlyph,
      this.specialCdText,
      el('span', { class: 'gk-hud__keycap gk-display', text: 'SHIFT' }),
      this.specialName,
    ]);
    this.ultGlyph = el('span', { class: 'gk-hud__ability-glyph' });
    this.ultPct = el('span', { class: 'gk-hud__ult-pct' });
    this.ultReady = el('span', { class: 'gk-hud__ult-ready gk-display', text: 'Q READY' });
    this.ultName = el('span', { class: 'gk-hud__ability-name' });
    // v1.3: READY but nothing valid to hit (ult preview) — replaces "Q READY" on the icon.
    this.ultNoTarget = el('span', { class: 'gk-hud__ult-notarget gk-display', text: 'NO TARGET' });
    this.ultCell = el('div', { class: 'gk-hud__ability gk-hud__ability--ult' }, [
      this.ultGlyph,
      this.ultPct,
      this.ultReady,
      this.ultNoTarget,
      el('span', { class: 'gk-hud__keycap gk-display', text: 'Q' }),
      this.ultName,
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
      hintKey('E / MMB', 'Lock-on'),
      hintKey('TAB', 'Next target'),
      hintKey('V', 'View'), // v1.3 WP-Q: first / third person
    ]);
    this.spectateEl = el('div', { class: 'gk-hud__spectate gk-display' });
    this.toastEl = el('div', { class: 'gk-hud__toast' });
    // v1.3: 'NO TARGET IN RANGE' flash (ult pressed with no valid target) and the LOCK tag
    // the ready-state preview pins over the would-be target.
    this.ultHintEl = el('div', { class: 'gk-hud__ult-hint gk-display', text: 'NO TARGET IN RANGE' });
    this.lockTagEl = el('div', { class: 'gk-hud__lock-tag gk-display', html: lockTagHtml() });

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
      this.toastEl,
      this.ultHintEl,
      this.lockTagEl,
    ]);
    root.appendChild(this.root);
    // QA handle (e.g. `__gkHud.pickupToast('speed')` from the console).
    (window as unknown as { __gkHud?: HUD }).__gkHud = this;

    this.lastHp = -1;
    this.lastAnimal = null;
    this.buffKey = '';
    this.hintHidden = false;
    this.lastCdText = '';
    this.lastUltPct = -1;
    this.lockTagOn = false;
    this.ultPreviewState = 'off';
    this.lastTerrainTag = null;
  }

  /**
   * The HUD's full-screen, pointer-transparent root (null when unmounted).
   * World-anchored overlays (nameplates, threat arrows) mount inside it so
   * they inherit its stacking and `pointer-events: none`.
   */
  get layer(): HTMLElement | null {
    return this.root;
  }

  unmount(): void {
    if (this.hitmarkerTimer !== null) window.clearTimeout(this.hitmarkerTimer);
    if (this.bloodlustTimer !== null) window.clearTimeout(this.bloodlustTimer);
    if (this.countdownTimer !== null) window.clearTimeout(this.countdownTimer);
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    if (this.ultHintTimer !== null) window.clearTimeout(this.ultHintTimer);
    if (this.ultShakeTimer !== null) window.clearTimeout(this.ultShakeTimer);
    this.hitmarkerTimer = this.bloodlustTimer = this.countdownTimer = this.toastTimer = null;
    this.ultHintTimer = this.ultShakeTimer = null;
    this.root?.remove();
    this.root = null;
    const w = window as unknown as { __gkHud?: HUD };
    if (w.__gkHud === this) delete w.__gkHud;
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
      this.nameplate.textContent = this.playerName ?? def.displayName;
      this.specialGlyph.innerHTML = abilityGlyphSvg(player.animal, 'special');
      this.ultGlyph.innerHTML = abilityGlyphSvg(player.animal, 'ultimate');
      this.specialName.textContent = def.special.name;
      this.ultName.textContent = def.ultimate.name;
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
    const cd = player.specialCd;
    const cdText = cd <= 0 ? '' : cd < 1 ? cd.toFixed(1) : `${Math.ceil(cd)}`;
    if (cdText !== this.lastCdText) {
      this.lastCdText = cdText;
      this.specialCdText.textContent = cdText;
    }

    // Ultimate ring 0–100 with charge %, then pulse + "Q READY" at full.
    const ultFrac = Math.min(1, Math.max(0, player.ultCharge / 100));
    this.ultCell.style.setProperty('--ult', String(ultFrac));
    this.ultCell.classList.toggle('is-ready', player.ultCharge >= 100);
    const pct = Math.floor(ultFrac * 100);
    if (pct !== this.lastUltPct) {
      this.lastUltPct = pct;
      this.ultPct.textContent = pct >= 100 ? '' : `${pct}%`;
    }

    // Low-HP vignette below 30% — deeper the lower you get.
    const low = player.alive && hpFrac < LOW_HP_FRAC;
    this.vignetteEl.classList.toggle('is-active', low);
    if (low) this.vignetteEl.style.setProperty('--low', String(1 - hpFrac / LOW_HP_FRAC));
  }

  /**
   * v1.8 jungle: show the terrain chip for the local player (`text`, e.g. "Swimming · 62 % speed") or hide it (`null`). Only
   * touches the DOM when the text changes; the chip is absolutely positioned above the vitals, so showing it shifts nothing.
   */
  setTerrainTag(text: string | null): void {
    if (this.root === null || text === this.lastTerrainTag) return;
    this.lastTerrainTag = text;
    if (text !== null) {
      this.terrainTagEl.textContent = text;
      this.terrainTagEl.dataset.kind = text.startsWith('Swimming') ? 'water' : 'moss';
    }
    this.terrainTagEl.classList.toggle('is-on', text !== null);
  }

  /** v1.5 online: show the player's chosen name on the vitals plate instead of the animal name (`null` restores it). */
  setPlayerName(name: string | null): void {
    this.playerName = name;
    if (this.root !== null && this.lastAnimal !== null) this.nameplate.textContent = name ?? ANIMALS[this.lastAnimal].displayName;
  }

  /** Push a kill-feed line (top-left, fades after 4 s). */
  killFeed(entry: KillFeedEntry): void {
    if (this.root === null) return;
    const row = el('div', { class: 'gk-hud__kf-row' });
    if (entry.killerIsPlayer === true) row.classList.add('is-player-kill');
    if (entry.victimIsPlayer === true) row.classList.add('is-player-death');
    const trap = entry.cause === 'trap';
    if (trap) row.classList.add('is-trap');
    const killer = trap
      ? `<span class="gk-hud__kf-icon is-trap is-trap--${entry.trapKind ?? 'any'}" title="Arena trap">${trapGlyphSvg(entry.trapKind)}</span>`
      : `<span class="gk-hud__kf-icon" style="color:${ANIMALS[entry.killerAnimal].accent}">${animalHeadSvg(entry.killerAnimal, 'gk-hud__kf-head')}</span>`;
    const kName = !trap && entry.killerName !== undefined ? `<span class="gk-hud__kf-name">${escapeHtml(entry.killerName)}</span>` : '';
    const vName = entry.victimName !== undefined ? `<span class="gk-hud__kf-name is-victim">${escapeHtml(entry.victimName)}</span>` : '';
    row.innerHTML = `
      ${killer}${kName}
      <span class="gk-hud__kf-sep">▸</span>
      <span class="gk-hud__kf-icon is-victim" style="color:${ANIMALS[entry.victimAnimal].accent}">${animalHeadSvg(entry.victimAnimal, 'gk-hud__kf-head')}</span>${vName}`;
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

  /**
   * Brief centre-lower toast when the player collects a pickup ("+250 HP",
   * "SPEED", "POWER" with the matching icon). Call on the player's own
   * `pickup` events.
   */
  pickupToast(kind: PickupState['kind']): void {
    if (this.root === null) return;
    const copy = TOAST_COPY[kind];
    this.toastEl.className = `gk-hud__toast is-${kind}`;
    this.toastEl.innerHTML = `
      <span class="gk-hud__toast-icon">${pickupIconSvg(kind)}</span>
      <span class="gk-hud__toast-text">
        <span class="gk-hud__toast-title gk-display">${copy.title}</span>
        <span class="gk-hud__toast-sub">${copy.sub}</span>
      </span>`;
    void this.toastEl.offsetWidth; // restart the animation
    this.toastEl.classList.add('is-active');
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('is-active'), TOAST_MS);
  }

  /**
   * v1.3 ready-state preview result for the ultimate icon: 'none' (bar full but
   * nothing valid to hit) swaps "Q READY" for a dim red "NO TARGET"; 'ok' / 'off'
   * restore it. Diffed, so it is safe to call every frame.
   */
  setUltPreview(state: 'off' | 'ok' | 'none'): void {
    if (this.root === null || state === this.ultPreviewState) return;
    this.ultPreviewState = state;
    this.ultCell.classList.toggle('is-notarget', state === 'none');
  }

  /**
   * v1.3: Q pressed with a full bar but no valid target (`ultimateFizzle`) — a
   * brief "NO TARGET IN RANGE" hint and a shake on the ultimate icon.
   */
  ultFizzle(): void {
    if (this.root === null) return;
    this.ultHintEl.classList.remove('is-active');
    void this.ultHintEl.offsetWidth; // restart the animation
    this.ultHintEl.classList.add('is-active');
    if (this.ultHintTimer !== null) window.clearTimeout(this.ultHintTimer);
    this.ultHintTimer = window.setTimeout(() => this.ultHintEl.classList.remove('is-active'), 1300);
    this.ultCell.classList.remove('is-shaking');
    void this.ultCell.offsetWidth;
    this.ultCell.classList.add('is-shaking');
    if (this.ultShakeTimer !== null) window.clearTimeout(this.ultShakeTimer);
    this.ultShakeTimer = window.setTimeout(() => this.ultCell.classList.remove('is-shaking'), 450);
  }

  /**
   * v1.3: gold "LOCK" bracket tag over the would-be ultimate target, at screen
   * position (`x`, `y`) in CSS pixels (its bottom-centre sits on the point).
   * `visible = false` hides it. Transform-only updates, no layout.
   */
  setLockTag(visible: boolean, x = 0, y = 0): void {
    if (this.root === null) return;
    if (!visible) {
      if (this.lockTagOn) {
        this.lockTagOn = false;
        this.lockTagEl.classList.remove('is-on');
      }
      return;
    }
    if (!this.lockTagOn) {
      this.lockTagOn = true;
      this.lockTagEl.classList.add('is-on');
    }
    this.lockTagEl.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
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
        <span class="gk-hud__spectate-hint">· LMB / TAB next</span>`;
    }
  }

  /**
   * Buff/debuff icons: a glyph per kind inside a remaining-time ring, with the
   * whole seconds left underneath. Rebuilt only when the set of kinds changes;
   * otherwise just the ring (CSS var) and changed second counts update.
   */
  private updateBuffs(buffs: readonly BuffState[]): void {
    let key = '';
    for (let i = 0; i < buffs.length; i++) key += (i > 0 ? ',' : '') + buffs[i].kind;
    if (key !== this.buffKey) {
      this.buffKey = key;
      this.buffBar.replaceChildren();
      this.buffTimeEls = [];
      this.buffSecs = [];
      for (const b of buffs) {
        const meta = BUFF_META[b.kind];
        const time = el('span', { class: 'gk-hud__buff-time' });
        const chip = el('span', {
          class: `gk-hud__buff gk-hud__buff--${b.kind} ${meta.good ? 'is-good' : 'is-bad'}`,
          title: meta.label,
          attrs: { 'aria-label': meta.label },
        });
        chip.innerHTML = `
          <svg class="gk-hud__buff-ring" viewBox="0 0 40 40" aria-hidden="true">
            <circle class="gk-hud__buff-track" cx="20" cy="20" r="17.5"/>
            <circle class="gk-hud__buff-arc" cx="20" cy="20" r="17.5" pathLength="100"/>
          </svg>
          <span class="gk-hud__buff-glyph">${buffIconSvg(b.kind)}</span>`;
        chip.appendChild(time);
        this.buffBar.appendChild(chip);
        this.buffTimeEls.push(time);
        this.buffSecs.push(-1);
      }
    }
    const chips = this.buffBar.children;
    for (let i = 0; i < buffs.length && i < chips.length; i++) {
      const b = buffs[i];
      const rem = b.dur > 0 ? Math.max(0, 1 - b.t / b.dur) : 1;
      (chips[i] as HTMLElement).style.setProperty('--rem', rem.toFixed(3));
      const secs = b.dur > 0 ? Math.max(0, Math.ceil(b.dur - b.t)) : -1;
      if (secs !== this.buffSecs[i]) {
        this.buffSecs[i] = secs;
        this.buffTimeEls[i].textContent = secs >= 0 ? String(secs) : '';
        (chips[i] as HTMLElement).classList.toggle('is-expiring', secs >= 0 && secs <= 2);
      }
    }
  }
}

function hintKey(key: string, action: string): HTMLElement {
  return el('span', { class: 'gk-hud__hint-item' }, [
    el('kbd', { class: 'gk-hud__hint-key', text: key }),
    el('span', { class: 'gk-hud__hint-action', text: action }),
  ]);
}

function lockTagHtml(): string {
  return `<span class="gk-hud__lock-label">LOCK</span><svg class="gk-hud__lock-caret" viewBox="0 0 16 10" aria-hidden="true">
    <path d="M1 1 L8 9 L15 1 Z" fill="currentColor"/>
  </svg>`;
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
