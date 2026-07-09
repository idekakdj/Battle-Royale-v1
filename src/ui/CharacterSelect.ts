/**
 * Character select screen (WP-F, BLUEPRINT §12).
 *
 * "CHOOSE YOUR GLADIATOR" over a 5×2 grid of accent-framed cards (inline-SVG
 * head icon, name + title; hover lift/glow, gold selected frame). The right
 * panel shows the 3D preview, animated stat pips, a difficulty chip, the full
 * move list rendered from REAL config numbers (never hard-coded — BLUEPRINT §8),
 * and a one-line real-animal lore. CONFIRM advances to difficulty select and
 * persists the choice (`gk-animal`).
 */

import type { Screen } from '../core/ScreenManager';
import type { AnimalId } from '../core/types';
import { el, button, clear } from './dom';
import { animalHeadSvg } from './icons';
import { PreviewPane } from './PreviewPane';
import { ANIMALS, ANIMAL_IDS, type AnimalDef, type StatPips } from '../config/animals';
import { saveAnimal, loadAnimal } from './storage';

export interface CharacterSelectOptions {
  /** Pre-selected gladiator; defaults to the stored `gk-animal`. */
  initialAnimal?: AnimalId;
  /** CONFIRM → difficulty select. The chosen animal is already persisted. */
  onConfirm: (animal: AnimalId) => void;
  /** Optional back-to-lobby affordance. */
  onBack?: () => void;
  /** Notified whenever the highlighted gladiator changes. */
  onSelectionChange?: (animal: AnimalId) => void;
}

const PIP_ROWS: readonly (readonly [keyof StatPips, string])[] = [
  ['hp', 'HP'],
  ['atk', 'ATK'],
  ['def', 'DEF'],
  ['spd', 'SPD'],
  ['rng', 'RNG'],
];

export class CharacterSelect implements Screen {
  private readonly opts: CharacterSelectOptions;
  private selected: AnimalId;
  private root: HTMLElement | null = null;
  private preview: PreviewPane | null = null;
  private infoEl: HTMLElement | null = null;
  private cards = new Map<AnimalId, HTMLElement>();

  constructor(opts: CharacterSelectOptions) {
    this.opts = opts;
    this.selected = opts.initialAnimal ?? loadAnimal();
  }

  mount(root: HTMLElement): void {
    const title = el('h1', { class: 'gk-cs__title gk-display', text: 'Choose Your Gladiator' });

    const grid = el('div', { class: 'gk-cs__grid' });
    for (const id of ANIMAL_IDS) {
      const card = this.buildCard(ANIMALS[id]);
      this.cards.set(id, card);
      grid.appendChild(card);
    }

    this.preview = new PreviewPane(this.selected, 'gk-preview gk-cs__preview');
    this.infoEl = el('div', { class: 'gk-cs__info' });

    const panel = el('div', { class: 'gk-cs__panel' }, [
      this.preview.root,
      this.infoEl,
      el('div', { class: 'gk-cs__actions' }, [
        this.opts.onBack !== undefined
          ? button('Back', 'gk-cs__back gk-display', () => this.opts.onBack?.())
          : null,
        button('Confirm', 'gk-cs__confirm gk-display', () => this.confirm()),
      ]),
    ]);

    const body = el('div', { class: 'gk-cs__body' }, [
      el('div', { class: 'gk-cs__gridwrap' }, [grid]),
      panel,
    ]);

    this.root = el('div', { class: 'gk-screen gk-cs' }, [title, body]);
    root.appendChild(this.root);

    this.select(this.selected, false);
  }

  unmount(): void {
    this.preview?.dispose();
    this.preview = null;
    this.cards.clear();
    this.root?.remove();
    this.root = null;
  }

  private buildCard(def: AnimalDef): HTMLElement {
    const card = el('button', {
      class: 'gk-cs__card',
      type: 'button',
      dataset: { animal: def.id },
    });
    card.style.setProperty('--accent', def.accent);
    card.innerHTML = `
      <span class="gk-cs__card-icon">${animalHeadSvg(def.id, 'gk-cs__head')}</span>
      <span class="gk-cs__card-name gk-display">${def.displayName}</span>
      <span class="gk-cs__card-title">${def.title}</span>`;
    card.addEventListener('click', () => this.select(def.id, true));
    return card;
  }

  private select(animal: AnimalId, notify: boolean): void {
    this.selected = animal;
    for (const [id, card] of this.cards) card.classList.toggle('is-selected', id === animal);
    this.preview?.setAnimal(animal);
    this.renderInfo(ANIMALS[animal]);
    if (this.root !== null) this.root.style.setProperty('--cs-accent', ANIMALS[animal].accent);
    if (notify) this.opts.onSelectionChange?.(animal);
  }

  private renderInfo(def: AnimalDef): void {
    if (this.infoEl === null) return;
    clear(this.infoEl);

    const header = el('div', { class: 'gk-cs__info-head' }, [
      el('h2', { class: 'gk-cs__info-name gk-display', text: def.displayName }),
      el('span', { class: 'gk-cs__info-title', text: def.title }),
      el('span', { class: `gk-cs__difficulty is-${def.difficultyTag.toLowerCase()}`, text: def.difficultyTag }),
    ]);

    this.infoEl.append(header, this.buildPips(def.statPips), this.buildMoves(def), this.buildLore(def));
  }

  private buildPips(pips: StatPips): HTMLElement {
    const rows = PIP_ROWS.map(([key, label]) => {
      const value = pips[key];
      const cells = Array.from({ length: 5 }, (_, i) =>
        el('span', { class: `gk-pip${i < value ? ' is-on' : ''}`, attrs: { style: `--i:${i}` } }),
      );
      return el('div', { class: 'gk-pips__row' }, [
        el('span', { class: 'gk-pips__label', text: label }),
        el('span', { class: 'gk-pips__track' }, cells),
      ]);
    });
    const wrap = el('div', { class: 'gk-pips' }, rows);
    // Trigger the fill animation after the element is in the DOM.
    requestAnimationFrame(() => wrap.classList.add('is-animated'));
    return wrap;
  }

  private buildMoves(def: AnimalDef): HTMLElement {
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    const combo = `${def.combo[0]} / ${def.combo[1]} / ${def.combo[2]}`;
    const finisherNote = def.finisher.name !== undefined ? ` · ${def.finisher.name}` : '';

    const moves = el('div', { class: 'gk-moves' }, [
      this.moveRow('Combo', `${combo} dmg`, `${def.attackRate.toFixed(2)}/s · ${def.range} m / ${def.arcDeg}°${finisherNote}`),
      this.moveRow('Block', `${pct(def.blockReduction)} reduction`, `Guard ${def.guardMax}`),
      this.moveRow(`Special · ${def.special.name}`, def.special.description, `Cooldown ${def.special.cooldown}s`),
      this.moveRow(`Ultimate · ${def.ultimate.name}`, def.ultimate.description, 'Charge 100'),
    ]);
    return moves;
  }

  private moveRow(label: string, primary: string, meta: string): HTMLElement {
    return el('div', { class: 'gk-moves__row' }, [
      el('div', { class: 'gk-moves__label gk-display', text: label }),
      el('div', { class: 'gk-moves__body' }, [
        el('div', { class: 'gk-moves__primary', text: primary }),
        el('div', { class: 'gk-moves__meta', text: meta }),
      ]),
    ]);
  }

  private buildLore(def: AnimalDef): HTMLElement {
    return el('div', { class: 'gk-cs__lore' }, [
      el('span', { class: 'gk-cs__lore-mark', text: '“' }),
      el('span', { class: 'gk-cs__lore-text', text: def.loreLine }),
    ]);
  }

  private confirm(): void {
    saveAnimal(this.selected);
    this.opts.onConfirm(this.selected);
  }
}
