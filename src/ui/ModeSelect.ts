/**
 * Mode select screen (v1.5.1): PLAY → "CHOOSE YOUR MODE". Two large cards, BATTLE ROYALE and CHAMPIONS LEAGUE; choosing one goes
 * straight to that mode's own gladiator-selection screen (the caller wires that: Battle Royale → CharacterSelect, Champions
 * League → its fighter/stage setup screen).
 *
 * Same dark-stone + gold language as CharacterSelect / BrawlSetup. Each card has a small illustration: the crossed swords on an
 * arena-coloured backdrop for Battle Royale, the real Broken Colosseum layout thumbnail for Champions League (both pure
 * string/CSS art — `stageThumb.ts` and `stages.ts` only import types, so the offline path does not pull in the brawl bundle).
 *
 * Keyboard: ←/→ move between the cards (Tab also moves, natively, through the cards and Back), ↓ goes to Back, Enter / Space
 * selects the focused card, Esc goes back. A mouse click on a card selects it. The last chosen mode (`gk-mode`) starts focused.
 */

import type { Screen } from '../core/ScreenManager';
import { el, button } from './dom';
import { crossedSwordsSvg } from './icons';
import { GAME_MODES, loadMode, saveMode, type GameMode } from './storage';
import { STAGE_DEFS } from '../brawl/data/stages';
import { stageThumbSvg } from '../brawl/ui/stageThumb';
import { BRAWL_OPPONENT_OPTIONS } from '../brawl/ui/setup';
import { STAGE_IDS } from '../brawl/types';

export interface ModeSelectOptions {
  /** Pre-focused mode; defaults to the stored `gk-mode`. */
  initialMode?: GameMode;
  /** A card was chosen (click / Enter). The mode is already persisted (`gk-mode`). Fires at most once per mount. */
  onSelect: (mode: GameMode) => void;
  /** Back button / Esc → the lobby. */
  onBack: () => void;
}

// ── pure content + keyboard model (unit-tested without a DOM) ───────────────────────────────────────────────────

export interface ModeInfo {
  readonly id: GameMode;
  readonly name: string;
  readonly blurb: string;
  readonly tags: readonly string[];
}

const minOpponents = Math.min(...BRAWL_OPPONENT_OPTIONS);
const maxOpponents = Math.max(...BRAWL_OPPONENT_OPTIONS);

/** Card copy for each mode. The Champions League tags are derived from the real setup options (bots, stages). */
export const MODE_INFO: Readonly<Record<GameMode, ModeInfo>> = {
  battleRoyale: {
    id: 'battleRoyale',
    name: 'Battle Royale',
    blurb: '10 gladiators, one winner. Fight through the colosseum against bots on four difficulty levels.',
    tags: ['Free-for-all', '3D arena', 'Ultimates'],
  },
  championsLeague: {
    id: 'championsLeague',
    name: 'Champions League',
    blurb: "Platform fighter. Build up rivals' damage and launch them off the stage.",
    tags: [`${minOpponents}–${maxOpponents} bots`, 'Stocks', `${STAGE_IDS.length} maps`],
  },
};

/** Where keyboard focus can be on this screen: one of the mode cards, or the Back button. */
export type ModeFocus = GameMode | 'back';

/**
 * Arrow-key focus movement. ←/→ cycle through the cards (wrapping), ↓ from a card goes to Back; from Back, ↑/←/→ return to
 * `lastMode` (the card that was focused before). Returns `null` for keys that do not move focus (Enter, Esc, Tab — those are
 * handled elsewhere / natively).
 */
export function nextModeFocus(from: ModeFocus, key: string, lastMode: GameMode): ModeFocus | null {
  if (from === 'back') {
    return key === 'ArrowUp' || key === 'ArrowLeft' || key === 'ArrowRight' ? lastMode : null;
  }
  const i = GAME_MODES.indexOf(from);
  if (i < 0) return null;
  if (key === 'ArrowLeft') return GAME_MODES[(i + GAME_MODES.length - 1) % GAME_MODES.length];
  if (key === 'ArrowRight') return GAME_MODES[(i + 1) % GAME_MODES.length];
  if (key === 'ArrowDown') return 'back';
  return null;
}

// ── illustrations ───────────────────────────────────────────────────────────────────────────────────────────────

/** Battle Royale art: the crossed-swords emblem over a golden-hour colosseum backdrop (CSS gradients, see `.gk-ms__art--br`). */
function battleRoyaleArt(): string {
  return `<span class="gk-ms__arena"></span>${crossedSwordsSvg('gk-ms__swords')}`;
}

/** Champions League art: the real Broken Colosseum layout thumbnail. */
function championsLeagueArt(): string {
  return stageThumbSvg(STAGE_DEFS.brokenColosseum);
}

// ── the screen ──────────────────────────────────────────────────────────────────────────────────────────────────

export class ModeSelect implements Screen {
  private readonly opts: ModeSelectOptions;
  private focusMode: GameMode;
  private chosen = false;
  private root: HTMLElement | null = null;
  private readonly cards = new Map<GameMode, HTMLButtonElement>();
  private backBtn: HTMLButtonElement | null = null;
  /** True while the Back button (not a card) holds keyboard focus: no card is highlighted then. */
  private onBackBtn = false;
  private readonly onKey = (e: KeyboardEvent): void => this.handleKey(e);

  constructor(opts: ModeSelectOptions) {
    this.opts = opts;
    this.focusMode = opts.initialMode ?? loadMode();
  }

  mount(host: HTMLElement): void {
    const title = el('h1', { class: 'gk-ms__title gk-display', text: 'Choose Your Mode' });

    const cards = el('div', { class: 'gk-ms__cards', attrs: { role: 'group', 'aria-label': 'Game mode' } });
    for (const mode of GAME_MODES) {
      const card = this.buildCard(MODE_INFO[mode]);
      this.cards.set(mode, card);
      cards.appendChild(card);
    }

    this.backBtn = button('Back', 'gk-ms__back gk-display', () => this.opts.onBack());
    this.backBtn.addEventListener('focus', () => {
      this.onBackBtn = true;
      this.syncFocus();
    });
    const hint = el('p', { class: 'gk-ms__hint' }, [
      el('kbd', { class: 'gk-controls__key', text: '←' }),
      el('kbd', { class: 'gk-controls__key', text: '→' }),
      ' Choose',
      el('span', { class: 'gk-ms__hint-sep', text: '·' }),
      el('kbd', { class: 'gk-controls__key', text: 'Enter' }),
      ' Select',
      el('span', { class: 'gk-ms__hint-sep', text: '·' }),
      el('kbd', { class: 'gk-controls__key', text: 'Esc' }),
      ' Back',
    ]);
    const footer = el('div', { class: 'gk-ms__footer' }, [this.backBtn, hint, el('span', { class: 'gk-ms__footer-balance' })]);

    this.root = el('div', { class: 'gk-screen gk-ms' }, [title, el('div', { class: 'gk-ms__body' }, [cards]), footer]);
    host.appendChild(this.root);

    this.syncFocus();
    document.addEventListener('keydown', this.onKey, true);
    // keyboard users start on the last chosen mode
    this.cards.get(this.focusMode)?.focus({ preventScroll: true });
  }

  unmount(): void {
    document.removeEventListener('keydown', this.onKey, true);
    this.cards.clear();
    this.backBtn = null;
    this.root?.remove();
    this.root = null;
  }

  private buildCard(info: ModeInfo): HTMLButtonElement {
    const art = el('span', {
      class: `gk-ms__art gk-ms__art--${info.id === 'battleRoyale' ? 'br' : 'cl'}`,
      html: info.id === 'battleRoyale' ? battleRoyaleArt() : championsLeagueArt(),
      attrs: { 'aria-hidden': 'true' },
    });
    const card = el(
      'button',
      { class: 'gk-ms__card', type: 'button', dataset: { mode: info.id } },
      [
        art,
        el('span', { class: 'gk-ms__name gk-display', text: info.name }),
        el('span', { class: 'gk-ms__desc', text: info.blurb }),
        el('span', { class: 'gk-ms__tags' }, info.tags.map((t) => el('span', { class: 'gk-ms__tag', text: t }))),
      ],
    );
    card.addEventListener('click', () => this.choose(info.id));
    // hovering a card highlights it: the highlight IS the keyboard focus, so Enter always acts on what the player sees
    card.addEventListener('mouseenter', () => card.focus({ preventScroll: true }));
    card.addEventListener('focus', () => {
      this.focusMode = info.id;
      this.onBackBtn = false;
      this.syncFocus();
    });
    return card;
  }

  private syncFocus(): void {
    for (const [mode, card] of this.cards) card.classList.toggle('is-focused', !this.onBackBtn && mode === this.focusMode);
  }

  private choose(mode: GameMode): void {
    if (this.chosen) return; // a double click must not start the next screen twice
    this.chosen = true;
    saveMode(mode);
    this.opts.onSelect(mode);
  }

  private currentFocus(): ModeFocus {
    return this.onBackBtn && document.activeElement === this.backBtn ? 'back' : this.focusMode;
  }

  private handleKey(e: KeyboardEvent): void {
    if (this.root === null || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.opts.onBack();
      return;
    }
    if (e.key === 'Enter') {
      // A held Enter (from the lobby's PLAY button) must not auto-repeat into a choice on this screen.
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      // Nothing focused (e.g. the mouse clicked PLAY and focus was lost): Enter chooses the highlighted card.
      if (e.target === document.body || e.target === null) {
        e.preventDefault();
        this.choose(this.focusMode);
      }
      return;
    }
    const next = nextModeFocus(this.currentFocus(), e.key, this.focusMode);
    if (next === null) return;
    e.preventDefault();
    if (next === 'back') this.backBtn?.focus({ preventScroll: true });
    else this.cards.get(next)?.focus({ preventScroll: true });
  }
}
