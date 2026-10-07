/**
 * Difficulty select screen (WP-F, BLUEPRINT §12) + the v1.8 Battle Royale MAP row.
 *
 * Four large cards driven entirely by `config/botProfiles.ts` — label, tagline, description, and the concrete behavior bullets
 * (§10). Under them a compact "Map" row (Colosseum | Jungle Clearing) with a thumbnail drawn from the real arena data and a
 * one-line blurb from the `ArenaDef`. START MATCH confirms and persists both choices (`gk-difficulty`, `gk-arena`).
 *
 * Map keyboard: with a map card focused ←/→ (or ↑/↓) move + select it (roving, wrapping); `M` anywhere on the screen cycles the
 * map; Tab/Enter/Space work natively on the cards (they are buttons). The difficulty cards keep their `.gk-ds__card` /
 * `.gk-ds__start` classes (the packaged-app smoke test clicks them); the map cards use `.gk-ds__map`.
 */

import type { Screen } from '../core/ScreenManager';
import type { ArenaId, Difficulty } from '../core/types';
import { ARENA_IDS } from '../core/types';
import { el, button } from './dom';
import { BOT_PROFILES, type BotProfile } from '../config/botProfiles';
import { getArena } from '../config/arenas';
import { arenaThumbSvg } from './mapThumb';
import { loadArena, loadDifficulty, saveArena, saveDifficulty } from './storage';

export interface DifficultySelectOptions {
  /** Pre-selected tier; defaults to the stored `gk-difficulty`. */
  initialDifficulty?: Difficulty;
  /** Pre-selected map; defaults to the stored `gk-arena` (colosseum on a first run / bad value). */
  initialArena?: ArenaId;
  /** START MATCH → the match (BLUEPRINT §3). Both choices are already persisted. */
  onStart: (difficulty: Difficulty, arena: ArenaId) => void;
  /** Optional back-to-character-select affordance. */
  onBack?: () => void;
}

const TIERS: readonly Difficulty[] = [1, 2, 3, 4];

// ── pure content + keyboard model (unit-tested without a DOM) ───────────────────────────────────────────────────

/** What one map card shows (all from the registered {@link ArenaDef}, so the blurb can never drift from the data). */
export interface MapChoice {
  readonly id: ArenaId;
  readonly name: string;
  readonly blurb: string;
}

/** The selectable Battle Royale maps in menu order (`ARENA_IDS`: colosseum first). */
export function mapChoices(): readonly MapChoice[] {
  return ARENA_IDS.map((id) => {
    const a = getArena(id);
    return { id, name: a.name, blurb: a.blurb };
  });
}

/** The map `delta` steps from `current` in menu order, wrapping (an unknown id behaves like the first). */
export function stepArena(current: ArenaId, delta: number): ArenaId {
  const n = ARENA_IDS.length;
  const i = Math.max(0, ARENA_IDS.indexOf(current));
  return ARENA_IDS[(((i + delta) % n) + n) % n];
}

/**
 * Map keyboard model: ←/↑ = previous, →/↓ = next (only when a map card has focus: `onMapCard`), `m`/`M` = next (anywhere on the
 * screen), Home / End = first / last (map card focused). Anything else → `null` (no change).
 */
export function mapKeyTarget(current: ArenaId, key: string, onMapCard: boolean): ArenaId | null {
  if (key === 'm' || key === 'M') return stepArena(current, 1);
  if (!onMapCard) return null;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return stepArena(current, -1);
    case 'ArrowRight':
    case 'ArrowDown':
      return stepArena(current, 1);
    case 'Home':
      return ARENA_IDS[0];
    case 'End':
      return ARENA_IDS[ARENA_IDS.length - 1];
    default:
      return null;
  }
}

// ── the screen ──────────────────────────────────────────────────────────────────────────────────────────────────

export class DifficultySelect implements Screen {
  private readonly opts: DifficultySelectOptions;
  private selected: Difficulty;
  private arena: ArenaId;
  private root: HTMLElement | null = null;
  private cards = new Map<Difficulty, HTMLElement>();
  private mapCards = new Map<ArenaId, HTMLElement>();
  private readonly onKey = (e: KeyboardEvent): void => this.handleKey(e);

  constructor(opts: DifficultySelectOptions) {
    this.opts = opts;
    this.selected = opts.initialDifficulty ?? loadDifficulty();
    this.arena = opts.initialArena ?? loadArena();
  }

  mount(root: HTMLElement): void {
    const title = el('h1', { class: 'gk-ds__title gk-display', text: 'Choose Your Opposition' });

    const grid = el('div', { class: 'gk-ds__grid' });
    for (const tier of TIERS) {
      const card = this.buildCard(BOT_PROFILES[tier]);
      this.cards.set(tier, card);
      grid.appendChild(card);
    }

    const maps = el('div', { class: 'gk-ds__maps', attrs: { role: 'radiogroup', 'aria-label': 'Map' } });
    for (const choice of mapChoices()) {
      const card = this.buildMapCard(choice);
      this.mapCards.set(choice.id, card);
      maps.appendChild(card);
    }
    const mapRow = el('div', { class: 'gk-ds__maprow' }, [
      el('span', { class: 'gk-ds__maplabel gk-display', text: 'Map' }),
      maps,
      el('span', { class: 'gk-ds__maphint' }, [el('kbd', { class: 'gk-controls__key', text: 'M' }), ' switch map']),
    ]);

    const actions = el('div', { class: 'gk-ds__actions' }, [
      this.opts.onBack !== undefined
        ? button('Back', 'gk-ds__back gk-display', () => this.opts.onBack?.())
        : null,
      button('Start Match', 'gk-ds__start gk-display', () => this.start()),
    ]);

    this.root = el('div', { class: 'gk-screen gk-ds' }, [title, grid, mapRow, actions]);
    root.appendChild(this.root);
    this.select(this.selected);
    this.selectArena(this.arena);
    document.addEventListener('keydown', this.onKey, true);
  }

  unmount(): void {
    document.removeEventListener('keydown', this.onKey, true);
    this.cards.clear();
    this.mapCards.clear();
    this.root?.remove();
    this.root = null;
  }

  /** The currently highlighted tier / map (read by tests and the QA tooling). */
  get choice(): { difficulty: Difficulty; arena: ArenaId } {
    return { difficulty: this.selected, arena: this.arena };
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

  private buildMapCard(choice: MapChoice): HTMLElement {
    const card = el(
      'button',
      {
        class: 'gk-ds__map',
        type: 'button',
        dataset: { arena: choice.id },
        attrs: { role: 'radio', 'aria-checked': 'false' },
      },
      [
        el('span', { class: 'gk-ds__mapart', html: arenaThumbSvg(getArena(choice.id), 'gk-ds__mapsvg'), attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'gk-ds__maptext' }, [
          el('span', { class: 'gk-ds__mapname gk-display', text: choice.name }),
          el('span', { class: 'gk-ds__mapblurb', text: choice.blurb }),
        ]),
      ],
    );
    card.addEventListener('click', () => this.selectArena(choice.id));
    return card;
  }

  private select(tier: Difficulty): void {
    this.selected = tier;
    for (const [t, card] of this.cards) card.classList.toggle('is-selected', t === tier);
  }

  private selectArena(arena: ArenaId): void {
    this.arena = arena;
    for (const [id, card] of this.mapCards) {
      const on = id === arena;
      card.classList.toggle('is-selected', on);
      card.setAttribute('aria-checked', on ? 'true' : 'false');
      card.tabIndex = on ? 0 : -1; // roving tabindex: Tab enters the group on the selected map
    }
  }

  private handleKey(e: KeyboardEvent): void {
    if (this.root === null || e.ctrlKey || e.metaKey || e.altKey) return;
    const active = document.activeElement;
    let onMapCard = false;
    for (const card of this.mapCards.values()) if (card === active) onMapCard = true;
    const next = mapKeyTarget(this.arena, e.key, onMapCard);
    if (next === null) return;
    e.preventDefault();
    this.selectArena(next);
    if (onMapCard) this.mapCards.get(next)?.focus({ preventScroll: true });
  }

  private start(): void {
    saveDifficulty(this.selected);
    saveArena(this.arena);
    this.opts.onStart(this.selected, this.arena);
  }
}
