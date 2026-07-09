/**
 * Difficulty select screen (WP-F, BLUEPRINT §12).
 *
 * Four large cards driven entirely by `config/botProfiles.ts` — label, tagline,
 * description, and the concrete behavior bullets (§10). START MATCH confirms and
 * persists the last choice (`gk-difficulty`).
 */

import type { Screen } from '../core/ScreenManager';
import type { Difficulty } from '../core/types';
import { el, button } from './dom';
import { BOT_PROFILES, type BotProfile } from '../config/botProfiles';
import { loadDifficulty, saveDifficulty } from './storage';

export interface DifficultySelectOptions {
  /** Pre-selected tier; defaults to the stored `gk-difficulty`. */
  initialDifficulty?: Difficulty;
  /** START MATCH → the match (BLUEPRINT §3). Choice is already persisted. */
  onStart: (difficulty: Difficulty) => void;
  /** Optional back-to-character-select affordance. */
  onBack?: () => void;
}

const TIERS: readonly Difficulty[] = [1, 2, 3, 4];

export class DifficultySelect implements Screen {
  private readonly opts: DifficultySelectOptions;
  private selected: Difficulty;
  private root: HTMLElement | null = null;
  private cards = new Map<Difficulty, HTMLElement>();

  constructor(opts: DifficultySelectOptions) {
    this.opts = opts;
    this.selected = opts.initialDifficulty ?? loadDifficulty();
  }

  mount(root: HTMLElement): void {
    const title = el('h1', { class: 'gk-ds__title gk-display', text: 'Choose Your Opposition' });

    const grid = el('div', { class: 'gk-ds__grid' });
    for (const tier of TIERS) {
      const card = this.buildCard(BOT_PROFILES[tier]);
      this.cards.set(tier, card);
      grid.appendChild(card);
    }

    const actions = el('div', { class: 'gk-ds__actions' }, [
      this.opts.onBack !== undefined
        ? button('Back', 'gk-ds__back gk-display', () => this.opts.onBack?.())
        : null,
      button('Start Match', 'gk-ds__start gk-display', () => this.start()),
    ]);

    this.root = el('div', { class: 'gk-screen gk-ds' }, [title, grid, actions]);
    root.appendChild(this.root);
    this.select(this.selected);
  }

  unmount(): void {
    this.cards.clear();
    this.root?.remove();
    this.root = null;
  }

  private buildCard(profile: BotProfile): HTMLElement {
    const bullets = profile.behaviors.map((b) => el('li', { class: 'gk-ds__bullet', text: b }));
    const card = el(
      'button',
      { class: 'gk-ds__card', type: 'button', dataset: { tier: String(profile.difficulty) } },
      [
        el('span', { class: 'gk-ds__tier gk-display', text: `${profile.difficulty}` }),
        el('span', { class: 'gk-ds__label gk-display', text: profile.label }),
        el('span', { class: 'gk-ds__tagline', text: `“${profile.tagline}”` }),
        el('ul', { class: 'gk-ds__bullets' }, bullets),
      ],
    );
    card.addEventListener('click', () => this.select(profile.difficulty));
    return card;
  }

  private select(tier: Difficulty): void {
    this.selected = tier;
    for (const [t, card] of this.cards) card.classList.toggle('is-selected', t === tier);
  }

  private start(): void {
    saveDifficulty(this.selected);
    this.opts.onStart(this.selected);
  }
}
